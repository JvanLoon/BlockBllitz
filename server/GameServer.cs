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
    public const int SendRate = 30;   // state broadcasts per second

    private const float MoveSpeed = 6f;    // world units per second
    private const float ArenaHalf = 19f;   // arena is 40x40, keep players just inside

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
            Step(dt);

            if (_tick % ticksPerSend == 0)
                await Broadcast(ct);
        }
    }

    private void Step(float dt)
    {
        foreach (var p in _players.Values)
        {
            var inp = p.Latest;
            p.Yaw = inp.Yaw;
            p.Pitch = inp.Pitch;

            float mx = (inp.Right ? 1f : 0f) - (inp.Left ? 1f : 0f);
            float mz = (inp.Fwd ? 1f : 0f) - (inp.Back ? 1f : 0f);
            if (mx == 0f && mz == 0f) continue;

            // Forward/right basis from yaw (matches Babylon's left-handed, Y-up convention).
            float sin = MathF.Sin(inp.Yaw), cos = MathF.Cos(inp.Yaw);
            float dx = sin * mz + cos * mx;   // forward.x*mz + right.x*mx
            float dz = cos * mz - sin * mx;   // forward.z*mz + right.z*mx
            float len = MathF.Sqrt(dx * dx + dz * dz);
            dx /= len; dz /= len;

            p.X = Math.Clamp(p.X + dx * MoveSpeed * dt, -ArenaHalf, ArenaHalf);
            p.Z = Math.Clamp(p.Z + dz * MoveSpeed * dt, -ArenaHalf, ArenaHalf);
        }
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
