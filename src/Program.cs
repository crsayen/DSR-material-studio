// DSR Texture Editor: edit Dark Souls Remastered's textures on their models, shaded with the game's
// own material model (FRPG_FS_HemEnv.fx PackMaterial), with parametric, non-destructive layers.
//
// The app is a web page (wwwroot: three.js + three-gpu-pathtracer) over a small ASP.NET Core server
// that reads the game files (SoulsFormatsNEXT, BCnEncoder.Net) and writes the project. Normally
// both run inside one window (Window.cs); the server listens on the loopback interface only.
//
// Import: the game folder (found through Steam, changeable), read through the ModEngine2 mods it
// enables when there are any. Export: a project folder the user picks. It holds
// texture-editor.project.json (every edited texture's layers, saved as they change) and the
// exported textures as <content id>.dds, the DSR lighting mod's runtime texture override format:
// a project made in that mod's texture_overrides\game folder is live in game.
//
//   DSR-texture-editor.exe [--game <game dir>]                 the window
//   DSR-texture-editor.exe --serve [--port 5199] [--game ...]  no window: the page in a browser
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Hosting.Server.Features;
using Microsoft.Extensions.FileProviders;
using TextureEditor;

bool serve = false; int port = -1; string gameArg = null;
for (int i = 0; i < args.Length; i++)
{
    if (args[i] == "--serve") serve = true;
    else if (args[i] == "--port" && i + 1 < args.Length) port = int.Parse(args[++i]);
    else if (args[i] == "--game" && i + 1 < args.Length) gameArg = args[++i];
}
if (serve) Native.UseParentConsole();
if (port < 0) port = serve ? 5199 : 0;   // the window takes any free port

var settings = Settings.Load();
if (gameArg != null) settings.GameFolder = gameArg;
if (string.IsNullOrEmpty(settings.GameFolder) || !GameFiles.LooksLikeGame(settings.GameFolder)) settings.GameFolder = GameFiles.FindGame();
Project project = null;
if (!string.IsNullOrEmpty(settings.LastProject)) try { project = Project.Open(settings.LastProject); } catch { }
// The game files come from the open project's game folder (projects may target different
// installs); without a project, from the default one in the settings.
string GameFolder() => project?.GameFolder ?? settings.GameFolder;
bool UseMods() => project?.UseMods ?? settings.UseMods;
GameFiles files = new GameFiles(GameFolder(), UseMods());

// The page: from the source tree when run from it (edits show on reload), else embedded in the exe.
IFileProvider web = null;
for (var dir = new DirectoryInfo(AppContext.BaseDirectory); dir != null && web == null; dir = dir.Parent)
    if (File.Exists(Path.Combine(dir.FullName, "wwwroot", "js", "app.js")) && File.Exists(Path.Combine(dir.FullName, "DSR-texture-editor.csproj")))
        web = new PhysicalFileProvider(Path.Combine(dir.FullName, "wwwroot"));
web ??= new ManifestEmbeddedFileProvider(typeof(Project).Assembly, "wwwroot");

var builder = WebApplication.CreateBuilder(new WebApplicationOptions { Args = Array.Empty<string>(), ContentRootPath = AppContext.BaseDirectory });
builder.WebHost.UseUrls($"http://127.0.0.1:{port}");
builder.Logging.SetMinimumLevel(LogLevel.Warning);
var app = builder.Build();
app.UseDefaultFiles(new DefaultFilesOptions { FileProvider = web });
app.UseStaticFiles(new StaticFileOptions { FileProvider = web, OnPrepareResponse = c => c.Context.Response.Headers["Cache-Control"] = "no-store" });

object State() => new
{
    game = new { folder = GameFolder(), ok = GameFiles.LooksLikeGame(GameFolder()), useMods = UseMods(), searchOrder = files.Roots, fromProject = project != null },
    defaultGame = new { folder = settings.GameFolder, useMods = settings.UseMods },
    project = project?.Summary(),
    recent = settings.RecentProjects.Where(Project.Exists).Take(8),
    native = Window.Active,   // native folder dialogs are available
};
app.MapGet("/api/state", () => Results.Json(State()));

// ---- settings: the game folder ----
app.MapPost("/api/settings", async (HttpRequest req) =>
{
    var body = JsonNode.Parse(await new StreamReader(req.Body).ReadToEndAsync());
    var folder = (string)body?["gameFolder"] ?? GameFolder();
    var useMods = (bool?)body?["useMods"] ?? UseMods();
    if (!GameFiles.LooksLikeGame(folder)) return Results.BadRequest($"{folder} does not look like the Dark Souls Remastered folder (no DarkSoulsRemastered.exe or parts folder).");
    if (project != null) project.SetGame(folder, useMods);   // this project's install
    else { settings.GameFolder = folder; settings.UseMods = useMods; settings.Save(); }
    files = new GameFiles(folder, useMods);
    return Results.Json(State());
});

// ---- folders: the native dialog in the window, the page's own browser otherwise ----
app.MapGet("/api/fs/pick", (string title, string start) => Results.Json(new { path = Window.PickFolder(title ?? "Choose a folder", start) }));
app.MapGet("/api/fs/list", (string path) => Results.Json(FolderBrowser.List(path)));
app.MapPost("/api/fs/mkdir", (string path) =>
{
    try { Directory.CreateDirectory(path); return Results.Json(FolderBrowser.List(path)); }
    catch (Exception e) { return Results.BadRequest(e.Message); }
});

// ---- projects ----
app.MapPost("/api/project/create", (string folder, string gameFolder, bool useMods) =>
{
    try
    {
        if (!GameFiles.LooksLikeGame(gameFolder)) return Results.BadRequest($"{gameFolder} does not look like the Dark Souls Remastered folder (no DarkSoulsRemastered.exe or parts folder).");
        project = Project.Create(folder, gameFolder, useMods);
        files = new GameFiles(project.GameFolder, project.UseMods);
        settings.Remember(project.Folder); return Results.Json(State());
    }
    catch (Exception e) { return Results.BadRequest(e.Message); }
});
app.MapPost("/api/project/open", (string folder) =>
{
    try { project = Project.Open(folder); settings.Remember(project.Folder); files = new GameFiles(GameFolder(), UseMods()); return Results.Json(State()); }
    catch (Exception e) { return Results.BadRequest(e.Message); }
});
app.MapPost("/api/project/close", () => { project = null; settings.LastProject = null; settings.Save(); files = new GameFiles(GameFolder(), UseMods()); return Results.Json(State()); });

// ---- models and textures ----
app.MapGet("/api/models", () => Results.Json(files.ListModels()));
app.MapGet("/api/model", (string path) =>
{
    try { var m = files.LoadModel(path, project); project?.TouchModel(path); return Results.Json(m); }
    catch (Exception e) { return Results.Problem(e.Message); }
});
app.MapGet("/api/texture", (string id) =>
{
    var t = files.Texture(id);
    return t == null ? Results.NotFound() : Results.Bytes(t.Rgba, "application/octet-stream");
});

// ---- edits: the project's layers per texture, saved as they change ----
app.MapGet("/api/recipe", (string key) => Results.Text(project?.Recipe(key)?.ToJsonString() ?? "null", "application/json"));
app.MapPost("/api/recipe", async (HttpRequest req, string id) =>
{
    if (project == null) return Results.Conflict("No project: create or open one to keep edits.");
    var t = files.Texture(id); if (t == null) return Results.NotFound();
    var body = JsonNode.Parse(await new StreamReader(req.Body).ReadToEndAsync());
    project.SaveLayers(t, body?["layers"]?.AsArray());
    return Results.Ok();
});
app.MapPost("/api/export", async (HttpRequest req, string id, int width, int height) =>
{
    if (project == null) return Results.Conflict("No project: create or open one to export.");
    var t = files.Texture(id); if (t == null) return Results.NotFound();
    using var ms = new MemoryStream(); await req.Body.CopyToAsync(ms);
    var pixels = ms.ToArray();
    if (pixels.Length != width * height * 4 || width != t.Width || height != t.Height) return Results.BadRequest($"expected {t.Width}x{t.Height} RGBA");
    return Results.Json(new { written = project.Export(t, pixels) });
});
app.MapPost("/api/unexport", (string id) =>
{
    if (project == null) return Results.Conflict("No project.");
    var t = files.Texture(id); if (t == null) return Results.NotFound();
    return Results.Json(new { removed = project.Unexport(t) });
});

await app.StartAsync();
var url = app.Services.GetRequiredService<IServer>().Features.Get<IServerAddressesFeature>().Addresses.First().TrimEnd('/') + "/";
Console.WriteLine($"game {GameFolder()}\nsearch order: {string.Join(" > ", files.Roots)}\nproject {project?.Folder ?? "(none)"}\nDSR Texture Editor: {url}");
if (serve) await app.WaitForShutdownAsync();
else
{
    // Windows Forms wants a single-threaded apartment; the server keeps the main thread.
    var ui = new Thread(() => Window.Run(url, settings)) { Name = "ui" };
    ui.SetApartmentState(ApartmentState.STA);
    ui.Start(); ui.Join();
    await app.StopAsync();
}
