using System.Collections.Concurrent;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;

namespace BlockBlitz.Server;

/// <summary>
/// The authoritative game server. Holds all connected players, runs a fixed-timestep
/// simulation on a background loop, and broadcasts world snapshots to every client.
///
/// Design rule (so latency-hiding can be bolted on later without a rewrite):
/// clients send inputs only; this loop is the single source of truth for positions.
/// </summary>
public sealed class GameServer : BackgroundService
{
    public const int TickRate = 60;   // simulation steps per second
    // Interim smoothing measure: broadcast every tick (60Hz) to cut the strafe judder on
    // high-refresh displays. The real fix is client-side prediction + interpolation (Phase 4);
    // once that lands this can drop back to ~30Hz to save bandwidth.
    public const int SendRate = 60;   // state broadcasts per second

    private const float MoveSpeed = 6f;    // world units per second
    private const float ArenaHalf = 19f;   // arena is 40x40, keep players just inside

    // Combat tuning.
    private const float MaxHealth = 100f;
    private const float ShotDamage = 25f;      // 4 shots to down a full-health player
    private const float ShotRange = 100f;      // hitscan reach (covers the whole arena)
    private const float EyeHeight = 1.6f;      // must match the client camera height
    private const int FireIntervalTicks = 7;   // ~0.12s between shots at 60Hz
    private static readonly int RespawnDelayTicks = TickRate * 2; // 2s

    // Player hit box: axis-aligned, matching the 0.8 x 1.0 x 0.8 client box (centred at y=0.5).
    private const float BoxHalfXZ = 0.4f;
    private const float BoxBottom = 0f;
    private const float BoxTop = 1.0f;

    private static readonly JsonSerializerOptions Json = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        PropertyNameCaseInsensitive = true,
    };

    private readonly ConcurrentDictionary<string, Player> _players = new();
    private readonly ILogger<GameServer> _log;
    private uint _tick;

    public GameServer(ILogger<GameServer> log) => _log = log;

    // ---- Connection lifecycle -------------------------------------------------

    /// <summary>Handles one WebSocket connection for its whole lifetime.</summary>
    public async Task HandleClient(WebSocket socket, CancellationToken ct)
    {
        var player = new Player
        {
            Id = Guid.NewGuid().ToString("N")[..8],
            Socket = socket,
        };
        // Random spawn so two players don't stack on the origin.
        var rng = Random.Shared;
        player.X = (rng.NextSingle() * 2f - 1f) * 8f;
        player.Z = (rng.NextSingle() * 2f - 1f) * 8f;

        // Send the welcome BEFORE registering the player, so this send can't race with the
        // tick loop's broadcasts (which only touch registered players).
        await SendJson(socket, new
        {
            type = "welcome",
            id = player.Id,
            tickRate = TickRate,
            sendRate = SendRate,
        }, ct);

        _players[player.Id] = player;
        _log.LogInformation("Player {Id} connected ({Count} online)", player.Id, _players.Count);

        try
        {
            await ReceiveLoop(player, ct);
        }
        catch (OperationCanceledException) { /* shutting down */ }
        catch (WebSocketException) { /* client dropped */ }
        finally
        {
            _players.TryRemove(player.Id, out _);
            _log.LogInformation("Player {Id} disconnected ({Count} online)", player.Id, _players.Count);
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
                var input = JsonSerializer.Deserialize<InputMessage>(text, Json);
                if (input is not null) player.Latest = input;
            }
            catch (JsonException) { /* ignore malformed input */ }
        }
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
        }
        return result.MessageType == WebSocketMessageType.Text
            ? Encoding.UTF8.GetString(ms.GetBuffer(), 0, (int)ms.Length)
            : null;
    }

    // ---- Simulation -----------------------------------------------------------

    protected override async Task ExecuteAsync(CancellationToken ct)
    {
        var period = TimeSpan.FromSeconds(1.0 / TickRate);
        using var timer = new PeriodicTimer(period);
        const float dt = 1f / TickRate;
        int ticksPerSend = TickRate / SendRate;

        _log.LogInformation("Game loop started at {TickRate}Hz (broadcast {SendRate}Hz)", TickRate, SendRate);

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

    /// <summary>Advances the world one step. Returns the players whose shots connected this tick.</summary>
    private List<Player> Step(float dt)
    {
        var hitShooters = new List<Player>();

        foreach (var p in _players.Values)
        {
            var inp = p.Latest;
            p.Yaw = inp.Yaw;
            p.Pitch = inp.Pitch;

            // Respawn timer for the dead.
            if (!p.Alive)
            {
                if (_tick >= p.RespawnTick) Respawn(p);
                continue;
            }

            MovePlayer(p, inp, dt);

            // Firing: server owns the fire-rate cooldown so clients can't out-shoot it.
            if (inp.Fire && _tick >= p.NextShotTick)
            {
                p.NextShotTick = _tick + (uint)FireIntervalTicks;
                if (TryHitscan(p, out var target))
                {
                    target.Health -= ShotDamage;
                    hitShooters.Add(p);
                    if (target.Health <= 0f)
                    {
                        target.Alive = false;
                        target.RespawnTick = _tick + (uint)RespawnDelayTicks;
                        _log.LogInformation("Player {Killer} killed {Victim}", p.Id, target.Id);
                    }
                }
            }
        }

        return hitShooters;
    }

    private static void MovePlayer(Player p, InputMessage inp, float dt)
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

        p.X = Math.Clamp(p.X + dx * MoveSpeed * dt, -ArenaHalf, ArenaHalf);
        p.Z = Math.Clamp(p.Z + dz * MoveSpeed * dt, -ArenaHalf, ArenaHalf);
    }

    private void Respawn(Player p)
    {
        var rng = Random.Shared;
        p.X = (rng.NextSingle() * 2f - 1f) * 15f;
        p.Z = (rng.NextSingle() * 2f - 1f) * 15f;
        p.Health = MaxHealth;
        p.Alive = true;
    }

    /// <summary>
    /// Casts a ray from the shooter's eye along their view direction and returns the nearest
    /// alive player it hits within range. No lag compensation yet (Phase 4) — uses live positions.
    /// </summary>
    private bool TryHitscan(Player shooter, out Player hit)
    {
        hit = null!;

        // View direction from yaw/pitch (matches the client camera's Euler order).
        float cp = MathF.Cos(shooter.Pitch), sp = MathF.Sin(shooter.Pitch);
        float sy = MathF.Sin(shooter.Yaw), cy = MathF.Cos(shooter.Yaw);
        float dx = cp * sy, dy = -sp, dz = cp * cy;

        float ox = shooter.X, oy = EyeHeight, oz = shooter.Z;
        float best = ShotRange;

        foreach (var t in _players.Values)
        {
            if (ReferenceEquals(t, shooter) || !t.Alive) continue;

            if (RayAabb(ox, oy, oz, dx, dy, dz,
                        t.X - BoxHalfXZ, BoxBottom, t.Z - BoxHalfXZ,
                        t.X + BoxHalfXZ, BoxTop, t.Z + BoxHalfXZ,
                        out float dist) && dist < best)
            {
                best = dist;
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
                x = p.X, y = p.Y, z = p.Z,
                yaw = p.Yaw, pitch = p.Pitch,
                hp = p.Health, alive = p.Alive,
            }).ToArray(),
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
