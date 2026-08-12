using System.Collections.Concurrent;
using System.Net.WebSockets;

namespace BlockBlitz.Server;

/// <summary>
/// Server-side state for one connected player. Position/orientation are owned and mutated
/// only by the game tick loop. Inputs arrive on the receive-loop thread via <see cref="Inputs"/>
/// (a concurrent queue) and are drained by the tick loop.
/// </summary>
public sealed class Player
{
    /// <summary>Ticks of position history kept for lag compensation (~1s at 60Hz).</summary>
    public const int HistorySize = 64;

    public required string Id { get; init; }
    public required WebSocket Socket { get; init; }

    // World position (Y is fixed for now — flat arena).
    public float X;
    public float Y = 0.5f;
    public float Z;

    // Orientation the player last reported (used for movement direction and aiming).
    public float Yaw;
    public float Pitch;

    // Identity / scoring.
    public string Name = "";
    public int Kills;
    public int Deaths;

    // Combat state (owned by the tick loop).
    public float Health = 100f;
    public bool Alive = true;
    public int Ammo = 30;
    public bool Reloading;
    public uint ReloadDoneTick;  // tick a reload completes
    public uint NextShotTick;    // earliest tick this player may fire again
    public uint RespawnTick;     // tick at which a dead player respawns

    /// <summary>Inputs queued by the receive loop, drained by the tick loop.</summary>
    public readonly ConcurrentQueue<InputMessage> Inputs = new();

    /// <summary>The last input this client sent, used for firing/reload after movement is applied.</summary>
    public InputMessage Latest = InputMessage.Empty;

    /// <summary>Seq of the last input the server has processed — echoed to the client as the ack.</summary>
    public uint AckSeq;

    /// <summary>Position history for lag compensation, indexed by (tick % HistorySize).</summary>
    public readonly (uint Tick, float X, float Z)[] Hist = new (uint, float, float)[HistorySize];
}
