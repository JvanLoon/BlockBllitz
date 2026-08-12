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
    bool SemiAuto);

/// <summary>The four starting loadout weapons, indexed 0-3 (matches the client's 1-4 keys).</summary>
public static class Weapons
{
    public const int Pistol = 0;
    public const int Smg = 1;
    public const int Rifle = 2;
    public const int Shotgun = 3;

    public static readonly WeaponDef[] All =
    {
        // Pistol: semi-auto (one shot per click), hard-hitting, small mag.
        new("Pistol", Damage: 34f, FireIntervalTicks: 17, MagSize: 10, ReloadTicks: 66,
            Range: 100f, Pellets: 1, SpreadDeg: 0f, SemiAuto: true),

        // SMG: full-auto, fast fire rate, low per-shot damage, mild spread, short-ish range.
        new("SMG", Damage: 13f, FireIntervalTicks: 5, MagSize: 30, ReloadTicks: 90,
            Range: 55f, Pellets: 1, SpreadDeg: 1.2f, SemiAuto: false),

        // Rifle (machine gun): steady full-auto all-rounder.
        new("Rifle", Damage: 20f, FireIntervalTicks: 6, MagSize: 35, ReloadTicks: 120,
            Range: 100f, Pellets: 1, SpreadDeg: 0.6f, SemiAuto: false),

        // Shotgun: multi-pellet cone, devastating up close, useless at range.
        new("Shotgun", Damage: 9f, FireIntervalTicks: 45, MagSize: 6, ReloadTicks: 132,
            Range: 28f, Pellets: 8, SpreadDeg: 6f, SemiAuto: false),
    };

    /// <summary>Ticks between a weapon switch and being able to fire again.</summary>
    public const int EquipTicks = 12; // 0.2s at 60Hz

    public static int Clamp(int weaponIndex) => weaponIndex >= 0 && weaponIndex < All.Length ? weaponIndex : 0;
}
