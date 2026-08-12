namespace BlockBlitz.Server;

/// <summary>
/// Static definition of one weapon's combat stats. The server is authoritative for all of
/// these — damage, fire rate, ammo, reload time, range, and (for shotgun-style weapons)
/// pellet count/spread — so a client can never lie about what it's carrying.
/// </summary>
public readonly record struct WeaponDef(
    string Name,
    float Damage,
    int FireIntervalTicks,
    int MagSize,
    int ReloadTicks,
    float Range,
    int Pellets,
    float SpreadDeg,
    bool SemiAuto,
    bool InfiniteAmmo);

/// <summary>
/// The five weapon slots, indexed 0-4 (matches the client's 1-5 keys). Every player owns
/// the knife from the start; the four guns must be picked up from a weapon spawn on the
/// map (<see cref="Arena.WeaponPickups"/>) — see <c>Player.Owned</c>.
/// </summary>
public static class Weapons
{
    public const int Knife = 0;
    public const int Pistol = 1;
    public const int Smg = 2;
    public const int Rifle = 3;
    public const int Shotgun = 4;

    public static readonly WeaponDef[] All =
    {
        // Knife: melee. Infinite ammo, short range, one swing per click, hits hard.
        new("Knife", Damage: 55f, FireIntervalTicks: 24, MagSize: 1, ReloadTicks: 0,
            Range: 2.4f, Pellets: 1, SpreadDeg: 0f, SemiAuto: true, InfiniteAmmo: true),

        // Pistol: semi-auto (one shot per click), hard-hitting, small mag.
        new("Pistol", Damage: 34f, FireIntervalTicks: 17, MagSize: 10, ReloadTicks: 66,
            Range: 100f, Pellets: 1, SpreadDeg: 0f, SemiAuto: true, InfiniteAmmo: false),

        // SMG: full-auto, fast fire rate, low per-shot damage, mild spread, short-ish range.
        new("SMG", Damage: 13f, FireIntervalTicks: 5, MagSize: 30, ReloadTicks: 90,
            Range: 55f, Pellets: 1, SpreadDeg: 1.2f, SemiAuto: false, InfiniteAmmo: false),

        // Rifle (machine gun): steady full-auto all-rounder.
        new("Rifle", Damage: 20f, FireIntervalTicks: 6, MagSize: 35, ReloadTicks: 120,
            Range: 100f, Pellets: 1, SpreadDeg: 0.6f, SemiAuto: false, InfiniteAmmo: false),

        // Shotgun: multi-pellet cone, devastating up close, useless at range.
        new("Shotgun", Damage: 9f, FireIntervalTicks: 45, MagSize: 6, ReloadTicks: 132,
            Range: 28f, Pellets: 8, SpreadDeg: 6f, SemiAuto: false, InfiniteAmmo: false),
    };

    /// <summary>Ticks between a weapon switch and being able to fire again.</summary>
    public const int EquipTicks = 12; // 0.2s at 60Hz

    public static int Clamp(int weaponIndex) => weaponIndex >= 0 && weaponIndex < All.Length ? weaponIndex : Knife;
}
