namespace BlockBlitz.Server;

/// <summary>
/// A single input snapshot sent by a client. The server is authoritative, so clients
/// only ever report intent (which keys are held, where they are looking) — never a position.
/// </summary>
public sealed record InputMessage
{
    public bool Fwd { get; init; }
    public bool Back { get; init; }
    public bool Left { get; init; }
    public bool Right { get; init; }
    public bool Fire { get; init; }
    public bool Reload { get; init; }
    public bool Sprint { get; init; }
    public bool Jump { get; init; }
    public float Yaw { get; init; }
    public float Pitch { get; init; }

    /// <summary>Requested weapon slot (0-4). The server clamps and validates this.</summary>
    public int Weapon { get; init; }

    /// <summary>Client-assigned, monotonically increasing. Echoed back as the ack for reconciliation.</summary>
    public uint Seq { get; init; }

    /// <summary>The (fractional) server tick the client was rendering other players at — used for lag compensation.</summary>
    public float RenderTick { get; init; }

    public static readonly InputMessage Empty = new();
}
