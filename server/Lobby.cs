using System.Collections.Concurrent;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;

namespace BlockBlitz.Server;

/// <summary>
/// One independent match: an authoritative simulation with its own players, map, and tick
/// loop. The server can run many of these concurrently (see <see cref="LobbyManager"/>) — a
/// lobby is created on demand and torn down once empty. Holds all connected players, runs
/// a fixed-timestep simulation on a background loop, and broadcasts world snapshots to
/// every client in it.
///
/// Design rule (so latency-hiding can be bolted on later without a rewrite):
/// clients send inputs only; this loop is the single source of truth for positions.
/// </summary>
public sealed class Lobby
{
    public const int TickRate = 60;   // simulation steps per second
    // Interim smoothing measure: broadcast every tick (60Hz) to cut the strafe judder on
    // high-refresh displays. The real fix is client-side prediction + interpolation (Phase 4);
    // once that lands this can drop back to ~30Hz to save bandwidth.
    public const int SendRate = 60;   // state broadcasts per second

    private const float MoveSpeed = 6f;     // world units per second
    private const float SprintMult = 1.6f;  // Shift-held speed multiplier

    // Vertical movement. JumpSpeed/Gravity are tuned so a standing jump apexes at
    // JumpSpeed^2 / (2*Gravity) ≈ 2.08 units — comfortably over the Towers map house roof
    // (1.8 units, see Maps.cs) but well under anything meant to stay out of reach.
    private const float Gravity = 24f;
    private const float JumpSpeed = 10f;
    private const float RoofEpsilon = 0.05f; // landing tolerance so roof-edge float jitter doesn't reintroduce wall blocking

    // Combat tuning. Per-weapon damage/fire-rate/mag/reload live in Weapons.All.
    private const float MaxHealth = 100f;
    private const float EyeHeight = 1.6f;      // above the player's feet (p.Y); must match the client camera
    private const float PlayerHeight = 1.6f;   // hitbox top above p.Y — matches EyeHeight (eyes ~at head height)
    private static readonly int RespawnDelayTicks = TickRate * 2; // 2s

    private const float PlayerRadius = 0.4f;   // used for obstacle collision
    private const float BoxHalfXZ = 0.4f;      // player hit box horizontal half-extent

    // Weapon pickups: walk within this radius of a pad's centre while it's available to claim
    // its gun; it then goes on cooldown and reappears later.
    private const float PickupRadius = 1.1f;
    private static readonly uint PickupRespawnTicks = TickRate * 25; // 25s
    private readonly bool[] _pickupAvailable;
    private readonly uint[] _pickupRespawnTick;

    private static readonly JsonSerializerOptions Json = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        PropertyNameCaseInsensitive = true,
    };

    // Hardening limits.
    private const int InputQueueCap = 256;   // drop inputs past this to bound memory from a flood
    private const int MaxMessageBytes = 8192; // reject oversized WebSocket messages

    private readonly ConcurrentDictionary<string, Player> _players = new();
    private readonly ILogger _log;
    private readonly MapDef _map;
    private uint _tick;

    public string Code { get; }
    public string Name { get; }
    public int MaxPlayers { get; }
    public string MapId => _map.Id;
    public string MapName => _map.Name;
    public int PlayerCount => _players.Count;

    public Lobby(string code, string name, int maxPlayers, string mapId, ILogger log)
    {
        Code = code;
        Name = name;
        MaxPlayers = maxPlayers;
        _map = Maps.Get(mapId);
        _log = log;
        _pickupAvailable = _map.WeaponPickups.Select(_ => true).ToArray();
        _pickupRespawnTick = new uint[_map.WeaponPickups.Length];
    }

    // ---- Connection lifecycle -------------------------------------------------

    /// <summary>Handles one WebSocket connection for its whole lifetime.</summary>
    public async Task HandleClient(WebSocket socket, CancellationToken ct)
    {
        if (_players.Count >= MaxPlayers)
        {
            _log.LogInformation("Rejected connection: lobby {Code} full ({Count}/{Max})", Code, _players.Count, MaxPlayers);
            try { await SendJson(socket, new { type = "full" }, ct); } catch { /* best effort */ }
            try { await socket.CloseAsync(WebSocketCloseStatus.PolicyViolation, "server full", CancellationToken.None); }
            catch { /* best effort */ }
            return;
        }

        var player = new Player
        {
            Id = Guid.NewGuid().ToString("N")[..8],
            Socket = socket,
        };
        player.Name = "Blitzer-" + player.Id[..4];
        Spawn(player);

        // Send the welcome BEFORE registering the player, so this send can't race with the
        // tick loop's broadcasts (which only touch registered players). Includes the map
        // layout so the client renders identical cover.
        await SendJson(socket, new
        {
            type = "welcome",
            id = player.Id,
            lobbyCode = Code,
            lobbyName = Name,
            mapId = _map.Id,
            mapName = _map.Name,
            tickRate = TickRate,
            sendRate = SendRate,
            arenaHalf = _map.ArenaHalf,
            moveSpeed = MoveSpeed,
            sprintMult = SprintMult,
            gravity = Gravity,
            jumpSpeed = JumpSpeed,
            playerRadius = PlayerRadius,
            eyeHeight = EyeHeight,
            playerHeight = PlayerHeight,
            obstacles = _map.Obstacles.Select(o => new
            {
                x = o.X, z = o.Z, hx = o.HalfX, hz = o.HalfZ, h = o.Height, climbable = o.Climbable,
            }).ToArray(),
            weapons = Weapons.All.Select(w => new
            {
                name = w.Name,
                mag = w.MagSize,
                fireMs = w.FireIntervalTicks * 1000 / TickRate,
                reloadMs = w.ReloadTicks * 1000 / TickRate,
                semiAuto = w.SemiAuto,
                infiniteAmmo = w.InfiniteAmmo,
            }).ToArray(),
            weaponPickups = _map.WeaponPickups.Select(p => new { x = p.X, z = p.Z, weapon = p.Weapon }).ToArray(),
        }, ct);

        _players[player.Id] = player;
        _log.LogInformation("Player {Id} joined lobby {Code} ({Count} online)", player.Id, Code, _players.Count);

        try
        {
            await ReceiveLoop(player, ct);
        }
        catch (OperationCanceledException) { /* shutting down */ }
        catch (WebSocketException) { /* client dropped */ }
        finally
        {
            _players.TryRemove(player.Id, out _);
            _log.LogInformation("Player {Id} left lobby {Code} ({Count} online)", player.Id, Code, _players.Count);
            if (socket.State == WebSocketState.Open)
            {
                try { await socket.CloseAsync(WebSocketCloseStatus.NormalClosure, "bye", CancellationToken.None); }
                catch { /* best effort */ }
            }
        }
    }

    private async Task ReceiveLoop(Player player, CancellationToken ct)
    {
        var buffer = new byte[4096];
        while (player.Socket.State == WebSocketState.Open && !ct.IsCancellationRequested)
        {
            var text = await ReceiveText(player.Socket, buffer, ct);
            if (text is null) break; // close frame or non-text

            try
            {
                using var doc = JsonDocument.Parse(text);
                var type = doc.RootElement.TryGetProperty("type", out var tp) ? tp.GetString() : null;

                if (type == "join")
                {
                    if (doc.RootElement.TryGetProperty("name", out var nm))
                    {
                        var name = Sanitize(nm.GetString());
                        if (name.Length > 0) player.Name = name;
                    }
                }
                else
                {
                    var input = JsonSerializer.Deserialize<InputMessage>(text, Json);
                    if (input is not null && player.Inputs.Count < InputQueueCap)
                        player.Inputs.Enqueue(Sanitize(input));
                }
            }
            catch (JsonException) { /* ignore malformed message */ }
        }
    }

    private static string Sanitize(string? s)
    {
        if (string.IsNullOrWhiteSpace(s)) return "";
        var t = s.Trim();
        if (t.Length > 16) t = t[..16];
        var sb = new StringBuilder(t.Length);
        foreach (var c in t)
            if (!char.IsControl(c)) sb.Append(c);
        return sb.ToString();
    }

    /// <summary>Guards against malformed/hostile input: no NaN/Inf, pitch clamped, sane render tick.</summary>
    private static InputMessage Sanitize(InputMessage m)
    {
        static float Finite(float v) => float.IsFinite(v) ? v : 0f;
        return m with
        {
            Yaw = Finite(m.Yaw),
            Pitch = Math.Clamp(Finite(m.Pitch), -1.55f, 1.55f),
            RenderTick = float.IsFinite(m.RenderTick) && m.RenderTick > 0f ? m.RenderTick : 0f,
            Weapon = Weapons.Clamp(m.Weapon),
        };
    }

    /// <summary>Reads one full text message, reassembling fragments if needed.</summary>
    private static async Task<string?> ReceiveText(WebSocket socket, byte[] buffer, CancellationToken ct)
    {
        var result = await socket.ReceiveAsync(buffer, ct);
        if (result.MessageType == WebSocketMessageType.Close) return null;

        if (result.EndOfMessage && result.MessageType == WebSocketMessageType.Text)
            return Encoding.UTF8.GetString(buffer, 0, result.Count);

        // Rare path: message spanned multiple frames.
        using var ms = new MemoryStream();
        ms.Write(buffer, 0, result.Count);
        while (!result.EndOfMessage)
        {
            result = await socket.ReceiveAsync(buffer, ct);
            if (result.MessageType == WebSocketMessageType.Close) return null;
            ms.Write(buffer, 0, result.Count);
            if (ms.Length > MaxMessageBytes) return null; // oversized; drop the connection's message
        }
        return result.MessageType == WebSocketMessageType.Text
            ? Encoding.UTF8.GetString(ms.GetBuffer(), 0, (int)ms.Length)
            : null;
    }

    // ---- Simulation -----------------------------------------------------------

    /// <summary>The tick loop for this one lobby. Runs until <paramref name="ct"/> is cancelled
    /// (the lobby manager cancels it once the lobby has been empty for a while).</summary>
    public async Task RunAsync(CancellationToken ct)
    {
        var period = TimeSpan.FromSeconds(1.0 / TickRate);
        using var timer = new PeriodicTimer(period);
        const float dt = 1f / TickRate;
        int ticksPerSend = TickRate / SendRate;

        _log.LogInformation("Lobby {Code} '{Name}' started on map {Map} at {TickRate}Hz (broadcast {SendRate}Hz, max {Max})",
            Code, Name, _map.Id, TickRate, SendRate, MaxPlayers);

        try
        {
            while (await timer.WaitForNextTickAsync(ct))
            {
                _tick++;
                var hitShooters = Step(dt);

                // Tell each shooter their shot connected, so the client can show a hitmarker.
                foreach (var shooter in hitShooters)
                    await SendJson(shooter.Socket, new { type = "hit" }, ct);

                if (_tick % ticksPerSend == 0)
                    await Broadcast(ct);
            }
        }
        catch (OperationCanceledException) { /* lobby closed */ }
    }

    /// <summary>Advances the world one step. Returns the players whose shots connected this tick.</summary>
    private List<Player> Step(float dt)
    {
        var hitShooters = new List<Player>();

        for (int i = 0; i < _map.WeaponPickups.Length; i++)
            if (!_pickupAvailable[i] && _tick >= _pickupRespawnTick[i]) _pickupAvailable[i] = true;

        foreach (var p in _players.Values)
        {
            // Drain every input received since last tick, applying each exactly once so the client's
            // prediction (which does the same) stays in agreement. Cap to bound a flood.
            int applied = 0;
            while (applied < 16 && p.Inputs.TryDequeue(out var qi))
            {
                p.Latest = qi;
                p.AckSeq = qi.Seq;
                p.Yaw = qi.Yaw;
                p.Pitch = qi.Pitch;
                if (p.Alive) { UpdateVertical(p, qi, dt); MovePlayer(p, qi, dt); }
                applied++;
            }

            // Respawn timer for the dead (they don't move or shoot).
            if (!p.Alive)
            {
                if (_tick >= p.RespawnTick) Spawn(p);
                RecordHistory(p);
                continue;
            }

            // Weapon pickups: claim any available pad within reach, granting that gun.
            for (int i = 0; i < _map.WeaponPickups.Length; i++)
            {
                if (!_pickupAvailable[i]) continue;
                var pu = _map.WeaponPickups[i];
                float dx = p.X - pu.X, dz = p.Z - pu.Z;
                if (dx * dx + dz * dz > PickupRadius * PickupRadius) continue;
                if (p.Owned[pu.Weapon]) continue; // already carrying it — leave it for someone else
                p.Owned[pu.Weapon] = true;
                p.Ammo[pu.Weapon] = Weapons.All[pu.Weapon].MagSize;
                _pickupAvailable[i] = false;
                _pickupRespawnTick[i] = _tick + PickupRespawnTicks;
            }

            var inp = p.Latest;

            // Weapon switch: only to a weapon this player actually owns. Cancel any reload in
            // progress and impose a short equip delay before the new weapon can fire, so
            // flicking between weapons isn't a free action.
            if (applied > 0 && inp.Weapon != p.WeaponIndex && p.Owned[inp.Weapon])
            {
                p.WeaponIndex = inp.Weapon;
                p.Reloading = false;
                p.NextShotTick = _tick + (uint)Weapons.EquipTicks;
            }
            var w = Weapons.All[p.WeaponIndex];

            // Reloading: finish an in-progress reload, or start one when requested (or
            // automatically when trying to fire on empty) and the mag isn't full. Infinite-ammo
            // weapons (the knife) never reload.
            if (p.Reloading)
            {
                if (_tick >= p.ReloadDoneTick) { p.CurrentAmmo = w.MagSize; p.Reloading = false; }
            }
            else if (!w.InfiniteAmmo && applied > 0 && (inp.Reload || (inp.Fire && p.CurrentAmmo == 0)) && p.CurrentAmmo < w.MagSize)
            {
                p.Reloading = true;
                p.ReloadDoneTick = _tick + (uint)w.ReloadTicks;
            }

            // Firing: server owns the fire-rate cooldown and ammo so clients can't cheat either.
            // Semi-auto weapons additionally require a fresh press (no holding down for auto-fire).
            bool hasAmmo = w.InfiniteAmmo || p.CurrentAmmo > 0;
            bool wantsFire = applied > 0 && inp.Fire && !p.Reloading && hasAmmo && _tick >= p.NextShotTick;
            if (w.SemiAuto && p.FireHeldPrev) wantsFire = false;
            if (wantsFire)
            {
                p.NextShotTick = _tick + (uint)w.FireIntervalTicks;
                if (!w.InfiniteAmmo) p.CurrentAmmo--;
                if (FireWeapon(p, w, inp.RenderTick))
                    hitShooters.Add(p);
            }
            if (applied > 0) p.FireHeldPrev = inp.Fire;

            RecordHistory(p);
        }

        return hitShooters;
    }

    private void RecordHistory(Player p) => p.Hist[_tick % Player.HistorySize] = (_tick, p.X, p.Z, p.Y);

    /// <summary>Rewinds a target to the fractional tick the shooter was rendering it at (lag comp).</summary>
    private (float X, float Z, float Y) RewindTarget(Player t, float renderTick)
    {
        // Fall back to the live position when the client didn't send a usable render tick.
        if (renderTick <= 0f || renderTick >= _tick) return (t.X, t.Z, t.Y);

        int t0 = (int)MathF.Floor(renderTick);
        int t1 = t0 + 1;
        var r0 = t.Hist[((t0 % Player.HistorySize) + Player.HistorySize) % Player.HistorySize];
        var r1 = t.Hist[((t1 % Player.HistorySize) + Player.HistorySize) % Player.HistorySize];
        if (r0.Tick != (uint)t0) return (t.X, t.Z, t.Y);   // history rolled over / too old
        if (r1.Tick != (uint)t1) return (r0.X, r0.Z, r0.Y); // no next sample yet
        float f = renderTick - t0;
        return (r0.X + (r1.X - r0.X) * f, r0.Z + (r1.Z - r0.Z) * f, r0.Y + (r1.Y - r0.Y) * f);
    }

    /// <summary>Gravity + jump. Runs before MovePlayer each input so horizontal collision
    /// (which is height-aware for climbable obstacles) sees this tick's up-to-date Y.</summary>
    private void UpdateVertical(Player p, InputMessage inp, float dt)
    {
        float surface = SurfaceHeightAt(p.X, p.Z);
        p.VelY -= Gravity * dt;
        p.Y += p.VelY * dt;
        if (p.Y <= surface)
        {
            p.Y = surface;
            p.VelY = 0f;
            p.Grounded = true;
        }
        else
        {
            p.Grounded = false;
        }
        // Holding Space chains jumps automatically on landing — no edge detection needed.
        if (inp.Jump && p.Grounded)
        {
            p.VelY = JumpSpeed;
            p.Grounded = false;
        }
    }

    private void MovePlayer(Player p, InputMessage inp, float dt)
    {
        float mx = (inp.Right ? 1f : 0f) - (inp.Left ? 1f : 0f);
        float mz = (inp.Fwd ? 1f : 0f) - (inp.Back ? 1f : 0f);
        if (mx == 0f && mz == 0f) return;

        // Forward/right basis from yaw (matches Babylon's left-handed, Y-up convention).
        float sin = MathF.Sin(inp.Yaw), cos = MathF.Cos(inp.Yaw);
        float dx = sin * mz + cos * mx;   // forward.x*mz + right.x*mx
        float dz = cos * mz - sin * mx;   // forward.z*mz + right.z*mx
        float len = MathF.Sqrt(dx * dx + dz * dz);
        dx /= len; dz /= len;

        float speed = inp.Sprint ? MoveSpeed * SprintMult : MoveSpeed;
        float half = _map.ArenaHalf;

        // Axis-separated resolution so players slide along cover instead of sticking.
        float nx = Math.Clamp(p.X + dx * speed * dt, -half, half);
        if (!BlockedAt(nx, p.Z, p.Y)) p.X = nx;
        float nz = Math.Clamp(p.Z + dz * speed * dt, -half, half);
        if (!BlockedAt(p.X, nz, p.Y)) p.Z = nz;
    }

    /// <summary>
    /// True if a player centred at (x,z) at height y would overlap any obstacle (inflated by
    /// radius). Climbable obstacles only block while below their roof — at or above it, you're
    /// standing on top and free to walk around.
    /// </summary>
    private bool BlockedAt(float x, float z, float y)
    {
        foreach (var o in _map.Obstacles)
        {
            bool overlapsXZ = x > o.X - o.HalfX - PlayerRadius && x < o.X + o.HalfX + PlayerRadius &&
                               z > o.Z - o.HalfZ - PlayerRadius && z < o.Z + o.HalfZ + PlayerRadius;
            if (!overlapsXZ) continue;
            if (o.Climbable && y >= o.Height - RoofEpsilon) continue;
            return true;
        }
        return false;
    }

    // Extra margin (beyond the wall-blocking footprint) that counts as "landed on the roof".
    // Without this, the standable zone and the solid wall share the exact same edge — jumping
    // from right against the wall (where BlockedAt stops horizontal approach in the first
    // place) leaves ~no room to clear the ledge before gravity pulls you back down just
    // outside the footprint. This gives jumping onto a climbable roof real forgiveness.
    private const float LandingMargin = 0.6f;

    /// <summary>The standing height at (x,z): 0 on flat ground, or a climbable obstacle's
    /// height if (x,z) is over (or just at the edge of) its roof (used for gravity/landing
    /// and jump eligibility).</summary>
    private float SurfaceHeightAt(float x, float z)
    {
        float surface = 0f;
        foreach (var o in _map.Obstacles)
        {
            if (!o.Climbable) continue;
            float pad = PlayerRadius + LandingMargin;
            if (x > o.X - o.HalfX - pad && x < o.X + o.HalfX + pad &&
                z > o.Z - o.HalfZ - pad && z < o.Z + o.HalfZ + pad)
                surface = MathF.Max(surface, o.Height);
        }
        return surface;
    }

    private void Spawn(Player p)
    {
        var (sx, sz) = PickSpawn(p);
        p.X = sx; p.Z = sz;
        p.Y = 0f;
        p.VelY = 0f;
        p.Grounded = true;
        p.Health = MaxHealth;
        // Full ammo in every weapon's mag; WeaponIndex is intentionally preserved across
        // respawns so a player keeps whatever they had equipped.
        for (int i = 0; i < Weapons.All.Length; i++) p.Ammo[i] = Weapons.All[i].MagSize;
        p.Reloading = false;
        p.Alive = true;
    }

    /// <summary>Pick the spawn point(s) farthest from any other alive player, breaking ties randomly.</summary>
    private (float X, float Z) PickSpawn(Player self)
    {
        float best = -1f;
        var candidates = new List<(float, float)>();
        foreach (var sp in _map.SpawnPoints)
        {
            float nearestSq = float.MaxValue;
            foreach (var q in _players.Values)
            {
                if (ReferenceEquals(q, self) || !q.Alive) continue;
                float ddx = q.X - sp.X, ddz = q.Z - sp.Z;
                nearestSq = MathF.Min(nearestSq, ddx * ddx + ddz * ddz);
            }
            if (nearestSq > best + 0.01f) { best = nearestSq; candidates.Clear(); candidates.Add(sp); }
            else if (nearestSq >= best - 0.01f) { candidates.Add(sp); }
        }
        return candidates[Random.Shared.Next(candidates.Count)];
    }

    /// <summary>
    /// Fires one weapon discharge: casts <see cref="WeaponDef.Pellets"/> hitscan rays (1 for
    /// normal guns, several for the shotgun's spread cone), applies damage per target hit
    /// (a target can take multiple pellets in one shot), and handles kills. Returns true if
    /// at least one pellet connected, so the caller can show the shooter a hitmarker.
    /// </summary>
    private bool FireWeapon(Player shooter, in WeaponDef w, float renderTick)
    {
        Dictionary<Player, float>? hits = null;
        float spreadRad = w.SpreadDeg * MathF.PI / 180f;

        for (int i = 0; i < w.Pellets; i++)
        {
            float yaw = shooter.Yaw, pitch = shooter.Pitch;
            if (spreadRad > 0f)
            {
                yaw += ((float)Random.Shared.NextDouble() - 0.5f) * spreadRad;
                pitch += ((float)Random.Shared.NextDouble() - 0.5f) * spreadRad;
            }
            if (TryHitscan(shooter, renderTick, w.Range, yaw, pitch, out var target))
            {
                hits ??= new Dictionary<Player, float>();
                hits.TryGetValue(target, out var cur);
                hits[target] = cur + w.Damage;
            }
        }
        if (hits is null) return false;

        foreach (var (target, dmg) in hits)
        {
            target.Health -= dmg;
            if (target.Health <= 0f && target.Alive)
            {
                target.Alive = false;
                target.RespawnTick = _tick + (uint)RespawnDelayTicks;
                shooter.Kills++;
                target.Deaths++;
                _log.LogInformation("{Killer} killed {Victim}", shooter.Name, target.Name);
            }
        }
        return true;
    }

    /// <summary>
    /// Casts a ray from the shooter's eye along the given aim direction (which may be
    /// perturbed from the shooter's actual yaw/pitch for weapon spread) and returns the
    /// nearest alive player it hits within range.
    /// </summary>
    private bool TryHitscan(Player shooter, float renderTick, float range, float yaw, float pitch, out Player hit)
    {
        hit = null!;

        // View direction from yaw/pitch (matches the client camera's Euler order).
        float cp = MathF.Cos(pitch), sp = MathF.Sin(pitch);
        float sy = MathF.Sin(yaw), cy = MathF.Cos(yaw);
        float dx = cp * sy, dy = -sp, dz = cp * cy;

        float ox = shooter.X, oy = shooter.Y + EyeHeight, oz = shooter.Z;

        // A shot can't pass through cover: the nearest wall along the ray caps the reach.
        float best = range;
        foreach (var o in _map.Obstacles)
        {
            if (RayAabb(ox, oy, oz, dx, dy, dz,
                        o.X - o.HalfX, 0f, o.Z - o.HalfZ,
                        o.X + o.HalfX, o.Height, o.Z + o.HalfZ,
                        out float wd) && wd < best)
                best = wd;
        }

        foreach (var t in _players.Values)
        {
            if (ReferenceEquals(t, shooter) || !t.Alive) continue;

            // Lag compensation: test against where the shooter actually saw the target
            // (including their vertical position, so hitting a jumping target is accurate).
            var (tx, tz, ty) = RewindTarget(t, renderTick);

            if (RayAabb(ox, oy, oz, dx, dy, dz,
                        tx - BoxHalfXZ, ty, tz - BoxHalfXZ,
                        tx + BoxHalfXZ, ty + PlayerHeight, tz + BoxHalfXZ,
                        out float dist) && dist < best)
            {
                best = dist;   // closer players also occlude players behind them
                hit = t;
            }
        }

        return hit is not null;
    }

    /// <summary>Slab-method ray/AABB intersection. Returns the entry distance along the ray.</summary>
    private static bool RayAabb(
        float ox, float oy, float oz, float dx, float dy, float dz,
        float minX, float minY, float minZ, float maxX, float maxY, float maxZ,
        out float dist)
    {
        dist = 0f;
        float tmin = 0f, tmax = float.PositiveInfinity;

        // X slab
        if (MathF.Abs(dx) < 1e-8f) { if (ox < minX || ox > maxX) return false; }
        else
        {
            float inv = 1f / dx;
            float t1 = (minX - ox) * inv, t2 = (maxX - ox) * inv;
            if (t1 > t2) (t1, t2) = (t2, t1);
            tmin = MathF.Max(tmin, t1); tmax = MathF.Min(tmax, t2);
            if (tmin > tmax) return false;
        }
        // Y slab
        if (MathF.Abs(dy) < 1e-8f) { if (oy < minY || oy > maxY) return false; }
        else
        {
            float inv = 1f / dy;
            float t1 = (minY - oy) * inv, t2 = (maxY - oy) * inv;
            if (t1 > t2) (t1, t2) = (t2, t1);
            tmin = MathF.Max(tmin, t1); tmax = MathF.Min(tmax, t2);
            if (tmin > tmax) return false;
        }
        // Z slab
        if (MathF.Abs(dz) < 1e-8f) { if (oz < minZ || oz > maxZ) return false; }
        else
        {
            float inv = 1f / dz;
            float t1 = (minZ - oz) * inv, t2 = (maxZ - oz) * inv;
            if (t1 > t2) (t1, t2) = (t2, t1);
            tmin = MathF.Max(tmin, t1); tmax = MathF.Min(tmax, t2);
            if (tmin > tmax) return false;
        }

        dist = tmin;
        return true;
    }

    private async Task Broadcast(CancellationToken ct)
    {
        if (_players.IsEmpty) return;

        var snapshot = new
        {
            type = "state",
            tick = _tick,
            players = _players.Values.Select(p => new
            {
                id = p.Id,
                name = p.Name,
                x = p.X, y = p.Y, z = p.Z, vy = p.VelY,
                yaw = p.Yaw, pitch = p.Pitch,
                hp = p.Health, alive = p.Alive,
                ammo = p.CurrentAmmo, reloading = p.Reloading, weapon = p.WeaponIndex, owned = p.Owned,
                kills = p.Kills, deaths = p.Deaths,
                seq = p.AckSeq,   // reconciliation ack for the owning client
            }).ToArray(),
            pickups = _pickupAvailable,
        };

        var bytes = JsonSerializer.SerializeToUtf8Bytes(snapshot, Json);

        // Only the tick loop sends, so there is never a concurrent send on the same socket.
        // Different sockets can go in parallel.
        var sends = _players.Values
            .Where(p => p.Socket.State == WebSocketState.Open)
            .Select(p => SendRaw(p.Socket, bytes, ct));
        await Task.WhenAll(sends);
    }

    private static Task SendJson(WebSocket socket, object payload, CancellationToken ct)
        => SendRaw(socket, JsonSerializer.SerializeToUtf8Bytes(payload, Json), ct);

    private static async Task SendRaw(WebSocket socket, byte[] bytes, CancellationToken ct)
    {
        try
        {
            await socket.SendAsync(bytes, WebSocketMessageType.Text, endOfMessage: true, ct);
        }
        catch (WebSocketException) { /* socket closing; receive loop will clean it up */ }
        catch (OperationCanceledException) { }
    }
}
