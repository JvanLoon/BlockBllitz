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
    public float Yaw { get; init; }
    public float Pitch { get; init; }

    public static readonly InputMessage Empty = new();
}
