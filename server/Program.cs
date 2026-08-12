using System.Text.Json;
using System.Text.Json.Serialization;
using BlockBlitz.Server;
using Microsoft.Extensions.FileProviders;

var builder = WebApplication.CreateBuilder(args);

// One LobbyManager for the process: it owns every live Lobby (each with its own players
// and tick loop) and sweeps away ones that have sat empty for a while.
builder.Services.AddSingleton<LobbyManager>();
builder.Services.AddHostedService(sp => sp.GetRequiredService<LobbyManager>());

var app = builder.Build();

// Serve the Babylon.js client as static files (index.html by default). The path is
// CLIENT_PATH when set (Docker), otherwise ../client relative to the app for local dev.
var clientPath = builder.Configuration["CLIENT_PATH"]
    ?? Path.GetFullPath(Path.Combine(builder.Environment.ContentRootPath, "..", "client"));
var files = new PhysicalFileProvider(clientPath);
app.UseDefaultFiles(new DefaultFilesOptions { FileProvider = files });
app.UseStaticFiles(new StaticFileOptions { FileProvider = files });

// Lightweight health probe for the tunnel / container orchestrator.
app.MapGet("/health", () => Results.Ok("ok"));

var jsonOpts = new JsonSerializerOptions { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };

// ---- Server browser: list/create lobbies over plain HTTP ------------------------

app.MapGet("/api/lobbies", (LobbyManager manager) => Results.Json(manager.ListLobbies(), jsonOpts));

app.MapPost("/api/lobbies", async (HttpRequest req, LobbyManager manager) =>
{
    CreateLobbyRequest? body;
    try { body = await req.ReadFromJsonAsync<CreateLobbyRequest>(jsonOpts); }
    catch (JsonException) { return Results.BadRequest(); }
    if (body is null) return Results.BadRequest();

    var lobby = manager.CreateLobby(body.Name, body.MaxPlayers);
    if (lobby is null) return Results.StatusCode(StatusCodes.Status503ServiceUnavailable);

    return Results.Json(new { code = lobby.Code, name = lobby.Name, maxPlayers = lobby.MaxPlayers }, jsonOpts);
});

// ---- Game connection: one WebSocket per player, routed to their lobby by ?code= ---

app.UseWebSockets();

app.Map("/ws", async context =>
{
    if (!context.WebSockets.IsWebSocketRequest)
    {
        context.Response.StatusCode = StatusCodes.Status400BadRequest;
        return;
    }

    var code = context.Request.Query["code"].ToString();
    var manager = context.RequestServices.GetRequiredService<LobbyManager>();

    using var socket = await context.WebSockets.AcceptWebSocketAsync();

    if (string.IsNullOrWhiteSpace(code) || !manager.TryGetLobby(code, out var lobby))
    {
        try
        {
            var bytes = JsonSerializer.SerializeToUtf8Bytes(new { type = "error", reason = "lobby_not_found" }, jsonOpts);
            await socket.SendAsync(bytes, System.Net.WebSockets.WebSocketMessageType.Text, true, context.RequestAborted);
            await socket.CloseAsync(System.Net.WebSockets.WebSocketCloseStatus.NormalClosure, "no such lobby", CancellationToken.None);
        }
        catch { /* best effort */ }
        return;
    }

    await lobby.HandleClient(socket, context.RequestAborted);
});

app.Run();

record CreateLobbyRequest([property: JsonPropertyName("name")] string? Name, [property: JsonPropertyName("maxPlayers")] int MaxPlayers);
