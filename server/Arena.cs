namespace BlockBlitz.Server;

/// <summary>An axis-aligned box obstacle. Vertically spans [0, Height].</summary>
public readonly record struct Obstacle(float X, float Z, float HalfX, float HalfZ, float Height);

/// <summary>A fixed map location where a specific gun (see Weapons.*) can be picked up.</summary>
public readonly record struct WeaponPickup(float X, float Z, int Weapon);

/// <summary>
/// Static arena layout — cover obstacles and spawn points. Single source of truth: the server
/// uses it for movement collision and hitscan blocking, and sends the obstacle list to clients
/// (in the welcome message) so their visuals match exactly.
/// </summary>
public static class Arena
{
    public const float Half = 19f; // arena floor is 40 x 40

    public static readonly Obstacle[] Obstacles =
    {
        // Four mid-field cover blocks.
        new(-6f, -6f, 1.5f, 1.5f, 2.5f),
        new( 6f, -6f, 1.5f, 1.5f, 2.5f),
        new(-6f,  6f, 1.5f, 1.5f, 2.5f),
        new( 6f,  6f, 1.5f, 1.5f, 2.5f),
        // Central long wall.
        new(0f, 0f, 4f, 0.6f, 3f),
        // Two crates near the ends.
        new(0f, -11f, 1f, 1f, 1.6f),
        new(0f,  11f, 1f, 1f, 1.6f),
    };

    public static readonly (float X, float Z)[] SpawnPoints =
    {
        (-15f, -15f), (15f, -15f), (-15f, 15f), (15f, 15f),
        (0f, -16f), (0f, 16f), (-16f, 0f), (16f, 0f),
    };

    // One gun per compass direction around the central wall, clear of every obstacle.
    public static readonly WeaponPickup[] WeaponPickups =
    {
        new(-6f, 0f, Weapons.Pistol),
        new(6f, 0f, Weapons.Shotgun),
        new(0f, -6f, Weapons.Smg),
        new(0f, 6f, Weapons.Rifle),
    };
}
