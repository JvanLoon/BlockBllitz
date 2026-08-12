namespace BlockBlitz.Server;

/// <summary>
/// An axis-aligned box obstacle. Vertically spans [0, Height]. Climbable obstacles (e.g. a
/// house) block movement like a solid wall while below their roof, but can be jumped onto
/// and freely walked around on top of — see Lobby.BlockedAt / SurfaceHeightAt.
/// </summary>
public readonly record struct Obstacle(float X, float Z, float HalfX, float HalfZ, float Height, bool Climbable = false);

/// <summary>A fixed map location where a specific gun (see Weapons.*) can be picked up.</summary>
public readonly record struct WeaponPickup(float X, float Z, int Weapon);

/// <summary>
/// One map's layout: arena size, cover obstacles, spawn points, and weapon pickups. A Lobby
/// picks one at creation time and uses it as the single source of truth for movement
/// collision and hitscan blocking, sending it to clients in the welcome message so their
/// visuals match exactly.
/// </summary>
public sealed class MapDef
{
    public required string Id { get; init; }
    public required string Name { get; init; }
    public required float ArenaHalf { get; init; }
    public required Obstacle[] Obstacles { get; init; }
    public required (float X, float Z)[] SpawnPoints { get; init; }
    public required WeaponPickup[] WeaponPickups { get; init; }
}

/// <summary>Registry of every map the server can host a lobby on.</summary>
public static class Maps
{
    public const string ClassicId = "classic";
    public const string TowersId = "towers";

    /// <summary>The original arena: a few cover blocks around a central wall. Always the
    /// public lobby's map.</summary>
    public static readonly MapDef Classic = new()
    {
        Id = ClassicId,
        Name = "Classic Arena",
        ArenaHalf = 19f, // arena floor is 40 x 40

        Obstacles = new Obstacle[]
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
        },

        SpawnPoints = new (float, float)[]
        {
            (-15f, -15f), (15f, -15f), (-15f, 15f), (15f, 15f),
            (0f, -16f), (0f, 16f), (-16f, 0f), (16f, 0f),
        },

        // One gun per compass direction around the central wall, clear of every obstacle.
        WeaponPickups = new WeaponPickup[]
        {
            new(-6f, 0f, Weapons.Pistol),
            new(6f, 0f, Weapons.Shotgun),
            new(0f, -6f, Weapons.Smg),
            new(0f, 6f, Weapons.Rifle),
        },
    };

    /// <summary>4x the linear size of Classic: a tower in each corner (tall, solid — pure
    /// cover/sightline blockers) and one climbable house in the middle whose roof a jump can
    /// reach (house height 1.8, comfortably under a standing jump's ~2.08 apex — see Lobby's
    /// Gravity/JumpSpeed).</summary>
    public static readonly MapDef Towers = new()
    {
        Id = TowersId,
        Name = "Towers & House",
        ArenaHalf = 79f, // arena floor is 160 x 160

        Obstacles = new Obstacle[]
        {
            new(-65f, -65f, 2.5f, 2.5f, 12f),
            new( 65f, -65f, 2.5f, 2.5f, 12f),
            new(-65f,  65f, 2.5f, 2.5f, 12f),
            new( 65f,  65f, 2.5f, 2.5f, 12f),
            // Simple house in the middle — climbable, so a jump lands you on the roof.
            new(0f, 0f, 5f, 5f, 1.8f, Climbable: true),
        },

        SpawnPoints = new (float, float)[]
        {
            (-60f, -60f), (60f, -60f), (-60f, 60f), (60f, 60f),
            (0f, -64f), (0f, 64f), (-64f, 0f), (64f, 0f),
        },

        WeaponPickups = new WeaponPickup[]
        {
            new(-24f, 0f, Weapons.Pistol),
            new(24f, 0f, Weapons.Shotgun),
            new(0f, -24f, Weapons.Smg),
            new(0f, 24f, Weapons.Rifle),
        },
    };

    public static readonly MapDef[] All = { Classic, Towers };

    public static MapDef Get(string? id) =>
        Array.Find(All, m => m.Id == id) ?? Classic;
}
