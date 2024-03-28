import OS from "os";
import FS from "fs";
import Path from "path";
import { spawn } from "child_process";
import parseArgs from "minimist";
import { BrowserWindow, app as application, dialog, session, shell } from "electron";
import { XMLParser } from "fast-xml-parser";
import FileDownloader from "nodejs-file-downloader";
import extractZip from "extract-zip";

const TANKI_ONLINE_URL = "https://tankionline.com/play/";
const TANKI_TWEAKS_EXTENSION_ID = "khcoecipddmigggaeokhmhmhjhlpcpnb";

const options = parseArgs(process.argv.slice(1));

async function main() {

    if (require("electron-squirrel-startup")) {
        application.quit(); return;
    }
    if (OS.platform() === "win32" &&
        process.env.GPU_SET !== "true") {
        spawn(process.execPath, process.argv.slice(1), {
            detached: true,
            env: {
                ...process.env,
                SHIM_MCCOMPAT: "0x800000001",
                GPU_SET: "true"
            }
        });
        application.quit(); return;
    }

    application.commandLine.appendSwitch("disable-renderer-backgrounding");
    application.commandLine.appendSwitch("force_high_performance_gpu");
    await application.whenReady();

    try {
        await fetch(options.url ?? TANKI_ONLINE_URL);
    } catch (error) {
        dialog.showErrorBox("Ошибка / Error",
            "Нет подключения к серверу игры.\n\n" +
            "Unable to connect to the game server.");
        application.quit(); return;
    }

    await updateAndLoadExtensions(application.getPath("userData"));
    createMainWindow();
}

function createMainWindow() {

    const window = new BrowserWindow({
        width: 1280,
        height: 800,
        minWidth: 1280,
        minHeight: 720,
        title: "Tanki Online",
        titleBarStyle: OS.platform() === "darwin" ?
            "hidden" : "default",
        show: false
    });
    if (OS.platform() === "win32")
        window.setIcon(Path.join(application.getAppPath(),
            "resources/icons/icon.ico"));
    if (OS.platform() === "linux")
        window.setIcon(Path.join(application.getAppPath(),
            "resources/icons/icon.png"));
    window.setMenuBarVisibility(false);

    window.webContents.setWindowOpenHandler(
        ({ url }) => {
            shell.openExternal(url);
            return { action: "deny" };
        });
    window.once("ready-to-show", () =>
        window.maximize());
    window.loadURL(options.url ?? TANKI_ONLINE_URL);
}

async function updateAndLoadExtensions(userDataPath: string) {

    const extensionsPath = Path.join(userDataPath, "extensions");
    if (!FS.existsSync(extensionsPath)) FS.mkdirSync(extensionsPath);

    const extensions = new Array<{ path: string; manifest: any }>();
    const directoryPaths =
        FS.readdirSync(extensionsPath, { withFileTypes: true })
            .filter((dirent) => dirent.isDirectory())
            .map((dirent) => dirent.path);
    for (const directoryPath of directoryPaths) {
        try {
            const manifestPath = Path.join(directoryPath, "manifest.json");
            if (!FS.existsSync(manifestPath)) continue;
            const manifest = JSON.parse(FS.readFileSync(manifestPath,
                { encoding: "utf-8" }));
            extensions.push({ path: directoryPath, manifest });
        } catch (error) {
            console.log(error);
        }
    }

    if (extensions.find((extension) =>
        extension.manifest.key === TANKI_TWEAKS_EXTENSION_ID) == null) {
        const tweaksExtension = {
            path: Path.join(extensionsPath, "tanki-tweaks"),
            manifest: {
                key: TANKI_TWEAKS_EXTENSION_ID
            }
        };
        extensions.push(tweaksExtension);
    }

    for (const extension of extensions) {
        try {
            await updateExtension(extension);
            await session.defaultSession
                .loadExtension(extension.path);
        } catch (error) {
            console.log(error);
        }
    }
}

async function updateExtension(extension: { path: string; manifest: any }) {

    const manifest = extension.manifest;
    if (manifest.key == null) return;
    const latestVersion = await getLatestExtensionVersion(manifest.key,
        manifest.version, manifest.update_url);
    if (manifest.version === latestVersion.version) return;

    const crxPath = Path.join(application.getPath("temp"),
        manifest.key + ".crx");
    const zipPath = Path.join(application.getPath("temp"),
        manifest.key + ".zip");
    try {
        await new FileDownloader({
            url: latestVersion.crx,
            directory: Path.dirname(crxPath),
            fileName: Path.basename(crxPath),
            cloneFiles: false
        }).download();
        FS.writeFileSync(zipPath, unwrapCRX(FS.readFileSync(crxPath)));
        FS.rmSync(extension.path, { recursive: true, force: true });
        await extractZip(zipPath, { dir: extension.path });
    } finally {
        FS.rmSync(crxPath, { force: true });
        FS.rmSync(zipPath, { force: true });
    }
}

async function getLatestExtensionVersion(
    id: string, version: string = "0.0.0.1", updateURL: string =
        "https://clients2.google.com/service/update2/crx"
): Promise<{ version: string; crx: string }> {

    const os =
        OS.platform() === "win32" ? "win" :
            OS.platform() === "darwin" ? "mac" : "linux";
    const arch =
        OS.arch() === "ia32" ? "x86-32" :
            OS.arch() === "x64" ? "x86-64" :
                OS.arch().startsWith("arm") ? "arm" : "x86-64";

    const queryParams = {
        response: "updatecheck",
        os, arch, nacl_arch: arch,
        prod: "chromiumcrx",
        prodchannel: "unknown",
        prodversion: process.versions.chrome ?? "9999.0.9999.0",
        acceptformat: "crx2,crx3",
        x: `id=${id}&v=${version}&uc`
    };
    const queryString = "?" + new URLSearchParams(queryParams).toString();
    const updateResponse = await fetch(new URL(queryString, updateURL));

    const responseXML =
        new XMLParser({ ignoreAttributes: false })
            .parse(await updateResponse.text());
    const updatecheckTag = responseXML.gupdate?.app?.updatecheck;
    if (!(updatecheckTag != null &&
        "@_version" in updatecheckTag &&
        "@_codebase" in updatecheckTag))
        throw new Error("invalid update response");
    return {
        version: updatecheckTag["@_version"],
        crx: updatecheckTag["@_codebase"]
    };
}

function unwrapCRX(buffer: Buffer): Buffer {

    function readCRXVersion(buffer: Buffer):
        "crx-2" | "crx-3" | null {
        const version = buffer.readUInt32LE(4);
        if (version === 2) return "crx-2";
        if (version === 3) return "crx-3";
        return null;
    }

    if (buffer.readUInt32BE(0) === 0x50_4B_03_04)
        return Buffer.copyBytesFrom(buffer);
    if (buffer.readUInt32BE(0) !== 0x43_72_32_34)
        throw new Error("invalid CRX header");
    const version = readCRXVersion(buffer);
    if (version === null)
        throw new Error("unknown CRX version");
    const offset = version === "crx-2" ?
        16 + buffer.readUInt32LE(8) + buffer.readUInt32LE(12) :
        12 + buffer.readUInt32LE(8);
    return Buffer.copyBytesFrom(buffer, offset);
}

main();