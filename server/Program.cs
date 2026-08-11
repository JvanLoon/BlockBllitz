using BlockBlitz.Server;
using Microsoft.Extensions.FileProviders;

var builder = WebApplication.CreateBuilder(args);

// Single GameServer instance, also run as the background game-loop hosted service.
builder.Services.AddSingleton<GameServer>();
builder.Services.AddHostedService(sp => sp.GetRequiredService<GameServer>());

var app = builder.Build();

// Serve the Babylon.js client (../client) as static files, index.html by default.
var clientPath = Path.GetFullPath(Path.Combine(builder.Environment.ContentRootPath, "..", "client"));
var files = new PhysicalFileProvider(clientPath);
app.UseDefaultFiles(new DefaultFilesOptions { FileProvider = files });
app.UseStaticFiles(new StaticFileOptions { FileProvider = files });

app.UseWebSockets();

app.Map("/ws", async context =>
{
    if (!context.WebSockets.IsWebSocketRequest)
    {
        context.Response.StatusCode = StatusCodes.Status400BadRequest;
        return;
    }

    using var socket = await context.WebSockets.AcceptWebSocketAsync();
    var server = context.RequestServices.GetRequiredService<GameServer>();
    await server.HandleClient(socket, context.RequestAborted);
});

app.Run();
