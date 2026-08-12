using System.Collections.Concurrent;
using System.Text;

namespace BlockBlitz.Server;

/// <summary>DTO for the server browser list.</summary>
public readonly record struct LobbySummary(string Code, string Name, int Count, int MaxPlayers, string MapId, string MapName);

/// <summary>
/// Owns every live <see cref="Lobby"/>: creates them on demand (one background tick loop
/// each), looks them up by join code for incoming WebSocket connections, lists them for the
/// server browser, and sweeps away ones that have sat empty for a while.
/// </summary>
public sealed class LobbyManager : BackgroundService
{
    private const int MaxLobbies = 200;       // hard ceiling so lobby creation can't be spammed unbounded
    private const int MinPlayers = 2;
    private static readonly TimeSpan EmptyGrace = TimeSpan.FromSeconds(30); // survive brief 0-player gaps
    private static readonly TimeSpan SweepInterval = TimeSpan.FromSeconds(5);
    private const string CodeChars = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no 0/O/1/I/L — easy to read aloud
    private const int CodeLength = 5;

    private sealed class Entry
    {
        public required Lobby Lobby { get; init; }
        public required CancellationTokenSource Cts { get; init; }
        public DateTime? EmptySince;
        public bool Permanent; // server-managed lobby: never reaped, regardless of player count
    }

    private readonly ConcurrentDictionary<string, Entry> _lobbies = new();
    private readonly ILoggerFactory _loggerFactory;
    private readonly ILogger<LobbyManager> _log;
    private readonly int _maxPlayersCap; // per-lobby ceiling; a creator's requested size is clamped to this

    public LobbyManager(ILoggerFactory loggerFactory, ILogger<LobbyManager> log, IConfiguration cfg)
    {
        _loggerFactory = loggerFactory;
        _log = log;
        _maxPlayersCap = Math.Max(MinPlayers, cfg.GetValue("MaxPlayers", 16));
    }

    /// <summary>Creates and starts a new lobby, or returns null if the server is at its lobby cap.</summary>
    public Lobby? CreateLobby(string? requestedName, int requestedMaxPlayers, string? mapId)
    {
        if (_lobbies.Count >= MaxLobbies) return null;

        var name = Sanitize(requestedName);
        if (name.Length == 0) name = "Lobby";
        var maxPlayers = Math.Clamp(requestedMaxPlayers, MinPlayers, _maxPlayersCap);

        var code = GenerateCode();
        if (code is null) return null; // exhausted attempts (extremely unlikely at 32^5 codes)

        return StartLobby(code, name, maxPlayers, Maps.Get(mapId).Id, permanent: false);
    }

    /// <summary>
    /// Creates a fixed-code, always-on lobby that the empty-lobby sweep never touches — used
    /// once at startup for the default public arena. Unlike <see cref="CreateLobby"/>, the
    /// caller picks the join code (so it can be a short, memorable, documented constant).
    /// </summary>
    public Lobby CreateManagedLobby(string code, string name, string mapId, int? maxPlayers = null) =>
        StartLobby(code, name, maxPlayers ?? _maxPlayersCap, mapId, permanent: true);

    private Lobby StartLobby(string code, string name, int maxPlayers, string mapId, bool permanent)
    {
        var lobby = new Lobby(code, name, maxPlayers, mapId, _loggerFactory.CreateLogger($"Lobby[{code}]"));
        var cts = new CancellationTokenSource();
        _lobbies[code] = new Entry { Lobby = lobby, Cts = cts, Permanent = permanent };

        _ = RunLobby(lobby, cts.Token);
        return lobby;
    }

    private async Task RunLobby(Lobby lobby, CancellationToken ct)
    {
        try { await lobby.RunAsync(ct); }
        catch (Exception ex) { _log.LogError(ex, "Lobby {Code} tick loop crashed", lobby.Code); }
    }

    public bool TryGetLobby(string code, out Lobby lobby)
    {
        if (_lobbies.TryGetValue(code.ToUpperInvariant(), out var entry)) { lobby = entry.Lobby; return true; }
        lobby = null!;
        return false;
    }

    /// <summary>Snapshot of every live lobby, for the server browser.</summary>
    public LobbySummary[] ListLobbies() =>
        _lobbies.Values
            .Select(e => new LobbySummary(e.Lobby.Code, e.Lobby.Name, e.Lobby.PlayerCount, e.Lobby.MaxPlayers, e.Lobby.MapId, e.Lobby.MapName))
            .OrderBy(s => s.Name, StringComparer.OrdinalIgnoreCase)
            .ToArray();

    private string? GenerateCode()
    {
        Span<char> buf = stackalloc char[CodeLength];
        for (int attempt = 0; attempt < 50; attempt++)
        {
            for (int i = 0; i < CodeLength; i++)
                buf[i] = CodeChars[Random.Shared.Next(CodeChars.Length)];
            var code = new string(buf);
            if (!_lobbies.ContainsKey(code)) return code;
        }
        return null;
    }

    private static string Sanitize(string? s)
    {
        if (string.IsNullOrWhiteSpace(s)) return "";
        var t = s.Trim();
        if (t.Length > 24) t = t[..24];
        var sb = new StringBuilder(t.Length);
        foreach (var c in t)
            if (!char.IsControl(c)) sb.Append(c);
        return sb.ToString();
    }

    // ---- Empty-lobby sweep ------------------------------------------------------

    protected override async Task ExecuteAsync(CancellationToken ct)
    {
        using var timer = new PeriodicTimer(SweepInterval);
        while (await timer.WaitForNextTickAsync(ct))
        {
            var now = DateTime.UtcNow;
            foreach (var (code, entry) in _lobbies)
            {
                if (entry.Permanent) continue;
                if (entry.Lobby.PlayerCount > 0) { entry.EmptySince = null; continue; }
                entry.EmptySince ??= now;
                if (now - entry.EmptySince.Value < EmptyGrace) continue;

                if (_lobbies.TryRemove(code, out _))
                {
                    entry.Cts.Cancel();
                    entry.Cts.Dispose();
                    _log.LogInformation("Reaped empty lobby {Code} '{Name}'", entry.Lobby.Code, entry.Lobby.Name);
                }
            }
        }
    }
}
