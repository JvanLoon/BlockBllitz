using System.Net.WebSockets;

namespace BlockBlitz.Server;

/// <summary>
/// Server-side state for one connected player. Position/orientation are owned and mutated
/// only by the game tick loop; <see cref="Latest"/> is written by the client's receive loop
/// and read by the tick loop, so access to it goes through a volatile read/write.
/// </summary>
public sealed class Player
{
    public required string Id { get; init; }
    public required WebSocket Socket { get; init; }

    // World position (Y is fixed for now — flat arena).
    public float X;
    public float Y = 0.5f;
    public float Z;

    // Orientation the player last reported (used for movement direction and aiming).
    public float Yaw;
    public float Pitch;

    // Combat state (owned by the tick loop).
    public float Health = 100f;
    public bool Alive = true;
    public uint NextShotTick;   // earliest tick this player may fire again
    public uint RespawnTick;    // tick at which a dead player respawns

    private InputMessage _latest = InputMessage.Empty;

    /// <summary>Most recent input from this client. Thread-safe reference swap.</summary>
    public InputMessage Latest
    {
        get => Volatile.Read(ref _latest);
        set => Volatile.Write(ref _latest, value);
    }
}
