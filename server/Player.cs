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

    // World position. Y is the height of the player's FEET — 0 on flat ground, or higher
    // while jumping/standing on a climbable obstacle (see Lobby.SurfaceHeightAt). Eye height
    // and the hitbox are both relative to this, so combat tracks jumping/elevation correctly.
    public float X;
    public float Y;
    public float Z;
    public float VelY;      // vertical velocity, u/s (gravity/jump)
    public bool Grounded = true;

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
    public bool Reloading;
    public uint ReloadDoneTick;  // tick a reload completes
    public uint NextShotTick;    // earliest tick this player may fire again
    public uint RespawnTick;     // tick at which a dead player respawns

    // Loadout: everyone starts with just the knife; guns are gained by walking over a
    // weapon pickup (see the lobby's MapDef.WeaponPickups) and kept across respawns once owned.
    public int WeaponIndex;
    public readonly bool[] Owned = CreateOwned();
    public readonly int[] Ammo = new int[Weapons.All.Length];
    public bool FireHeldPrev;    // for semi-auto edge detection

    private static bool[] CreateOwned()
    {
        var owned = new bool[Weapons.All.Length];
        owned[Weapons.Knife] = true;
        return owned;
    }

    public int CurrentAmmo
    {
        get => Ammo[WeaponIndex];
        set => Ammo[WeaponIndex] = value;
    }

    /// <summary>Inputs queued by the receive loop, drained by the tick loop.</summary>
    public readonly ConcurrentQueue<InputMessage> Inputs = new();

    /// <summary>The last input this client sent, used for firing/reload after movement is applied.</summary>
    public InputMessage Latest = InputMessage.Empty;

    /// <summary>Seq of the last input the server has processed — echoed to the client as the ack.</summary>
    public uint AckSeq;

    /// <summary>Position history for lag compensation, indexed by (tick % HistorySize).</summary>
    public readonly (uint Tick, float X, float Z, float Y)[] Hist = new (uint, float, float, float)[HistorySize];
}
