"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const fs_extra_1 = __importDefault(require("fs-extra"));
const path_1 = __importDefault(require("path"));
const execa_1 = __importDefault(require("execa"));
const toml_1 = __importDefault(require("@iarna/toml"));
const build_utils_1 = require("@vercel/build-utils");
const install_rust_1 = require("./install-rust");
const codegenFlags = [
    '-C',
    'target-cpu=ivybridge',
    '-C',
    'target-feature=-aes,-avx,+fxsr,-popcnt,+sse,+sse2,-sse3,-sse4.1,-sse4.2,-ssse3,-xsave,-xsaveopt'
];
exports.version = 3;
const builderDebug = process.env.VERCEL_BUILDER_DEBUG ? true : false;
async function parseTOMLStream(stream) {
    return toml_1.default.parse.stream(stream);
}
async function gatherExtraFiles(globMatcher, entrypoint) {
    if (!globMatcher)
        return {};
    build_utils_1.debug('Gathering extra files for the fs...');
    const entryDir = path_1.default.dirname(entrypoint);
    if (Array.isArray(globMatcher)) {
        const allMatches = await Promise.all(globMatcher.map((pattern) => build_utils_1.glob(pattern, entryDir)));
        return allMatches.reduce((acc, matches) => ({ ...acc, ...matches }), {});
    }
    return build_utils_1.glob(globMatcher, entryDir);
}
async function runUserScripts(entrypoint) {
    const entryDir = path_1.default.dirname(entrypoint);
    const buildScriptPath = path_1.default.join(entryDir, 'build.sh');
    const buildScriptExists = await fs_extra_1.default.pathExists(buildScriptPath);
    if (buildScriptExists) {
        build_utils_1.debug('Running `build.sh`...');
        await build_utils_1.runShellScript(buildScriptPath);
    }
}
function isExecaError(err) {
    return 'stderr' in err;
}
async function cargoLocateProject(config) {
    try {
        const { stdout: projectDescriptionStr } = await execa_1.default('cargo', ['locate-project'], config);
        const projectDescription = JSON.parse(projectDescriptionStr);
        if (projectDescription != null && projectDescription.root != null) {
            return projectDescription.root;
        }
    }
    catch (e) {
        if (e instanceof Error && isExecaError(e)) {
            if (!/could not find/g.test(e.stderr)) {
                console.error("Couldn't run `cargo locate-project`");
            }
        }
        throw e;
    }
    return null;
}
async function resolveBinary(meta, workPath, entrypointPath, cargoTomlFile, cargoToml, buildBinary) {
    const entrypointPathRelative = path_1.default.relative(workPath, entrypointPath);
    const bin = cargoToml.bin instanceof Array
        ? cargoToml.bin.find((bin) => bin.path === entrypointPathRelative)
        : null;
    let binName = bin && bin.name;
    if (bin == null) {
        binName = path_1.default
            .basename(entrypointPath)
            .replace(path_1.default.extname(entrypointPath), '')
            .replace('[', '_')
            .replace(']', '_');
        const tomlToWrite = toml_1.default.stringify({
            ...cargoToml,
            bin: [
                {
                    name: binName,
                    path: entrypointPath
                }
            ]
        });
        if (meta.isDev) {
            build_utils_1.debug('Backing up Cargo.toml file');
            await fs_extra_1.default.move(cargoTomlFile, `${cargoTomlFile}.backup`, {
                overwrite: true
            });
        }
        build_utils_1.debug('Writing following toml to file:', tomlToWrite);
        try {
            await fs_extra_1.default.writeFile(cargoTomlFile, tomlToWrite);
        }
        catch (error) {
            if (meta.isDev) {
                await restoreCargoToml(cargoTomlFile);
            }
            throw error;
        }
    }
    try {
        await buildBinary(binName);
    }
    catch (error) {
        if (bin == null && meta.isDev) {
            await restoreCargoToml(cargoTomlFile);
        }
    }
    if (bin == null && meta.isDev) {
        await restoreCargoToml(cargoTomlFile);
    }
    return binName;
}
async function restoreCargoToml(cargoTomlFile) {
    build_utils_1.debug('Restoring backed up Cargo.toml file');
    await fs_extra_1.default.move(`${cargoTomlFile}.backup`, cargoTomlFile, { overwrite: true });
}
async function buildSingleFile({ entrypoint, workPath, meta = {} }, downloadedFiles, extraFiles, rustEnv) {
    build_utils_1.debug('Building single file');
    const entrypointPath = downloadedFiles[entrypoint].fsPath;
    const entrypointDirname = path_1.default.dirname(entrypointPath);
    // Find a Cargo.toml file or TODO: create one
    const cargoTomlFile = await cargoLocateProject({
        env: rustEnv,
        cwd: entrypointDirname
    });
    // TODO: we're assuming there's a Cargo.toml file. We need to create one
    // otherwise
    let cargoToml;
    try {
        cargoToml = (await parseTOMLStream(fs_extra_1.default.createReadStream(cargoTomlFile)));
    }
    catch (err) {
        console.error('Failed to parse TOML from entrypoint:', entrypoint);
        throw err;
    }
    const binName = await resolveBinary(meta, workPath, entrypointPath, cargoTomlFile, cargoToml, async (binName) => {
        build_utils_1.debug('Running `cargo build`...');
        try {
            await execa_1.default('cargo', ['build', '--bin', binName].concat(builderDebug ? ['--verbose'] : ['--quiet', '--release']), {
                env: rustEnv,
                cwd: entrypointDirname,
                stdio: 'inherit'
            });
        }
        catch (err) {
            console.error('failed to `cargo build`');
            throw err;
        }
    });
    // The compiled binary in Windows has the `.exe` extension
    const binExtension = process.platform === 'win32' ? '.exe' : '';
    const bin = path_1.default.join(path_1.default.dirname(cargoTomlFile), 'target', builderDebug ? 'debug' : 'release', binName + binExtension);
    build_utils_1.debug('Binary file is: ' + bin);
    const bootstrap = 'bootstrap' + binExtension;
    const lambda = await build_utils_1.createLambda({
        files: {
            ...extraFiles,
            [bootstrap]: new build_utils_1.FileFsRef({ mode: 0o755, fsPath: bin })
        },
        handler: bootstrap,
        runtime: 'provided'
    });
    return { output: lambda };
}
async function build(opts) {
    await install_rust_1.installRustAndFriends();
    const { files, entrypoint, workPath, config, meta = {} } = opts;
    build_utils_1.debug('Downloading files');
    const downloadedFiles = await build_utils_1.download(files, workPath, meta);
    const entryPath = downloadedFiles[entrypoint].fsPath;
    const { PATH, HOME } = process.env;
    const rustEnv = {
        ...process.env,
        PATH: `${path_1.default.join(HOME, '.cargo/bin')}:${PATH}`,
        RUSTFLAGS: [process.env.RUSTFLAGS, ...codegenFlags]
            .filter(Boolean)
            .join(' ')
    };
    await runUserScripts(entryPath);
    const extraFiles = await gatherExtraFiles(config.includeFiles, entryPath);
    return buildSingleFile(opts, downloadedFiles, extraFiles, rustEnv);
}
exports.build = build;
async function prepareCache({ cachePath, entrypoint, workPath }) {
    build_utils_1.debug('Preparing cache...');
    let targetFolderDir;
    if (path_1.default.extname(entrypoint) === '.toml') {
        targetFolderDir = path_1.default.dirname(path_1.default.join(workPath, entrypoint));
    }
    else {
        const { PATH, HOME } = process.env;
        const rustEnv = {
            ...process.env,
            PATH: `${path_1.default.join(HOME, '.cargo/bin')}:${PATH}`,
            RUSTFLAGS: [process.env.RUSTFLAGS, ...codegenFlags]
                .filter(Boolean)
                .join(' ')
        };
        const entrypointDirname = path_1.default.dirname(path_1.default.join(workPath, entrypoint));
        const cargoTomlFile = await cargoLocateProject({
            env: rustEnv,
            cwd: entrypointDirname
        });
        if (cargoTomlFile != null) {
            targetFolderDir = path_1.default.dirname(cargoTomlFile);
        }
        else {
            // `Cargo.toml` doesn't exist, in `build` we put it in the same
            // path as the entrypoint.
            targetFolderDir = path_1.default.dirname(path_1.default.join(workPath, entrypoint));
        }
    }
    const cacheEntrypointDirname = path_1.default.join(cachePath, path_1.default.relative(workPath, targetFolderDir));
    // Remove the target folder to avoid 'directory already exists' errors
    fs_extra_1.default.removeSync(path_1.default.join(cacheEntrypointDirname, 'target'));
    fs_extra_1.default.mkdirpSync(cacheEntrypointDirname);
    // Move the target folder to the cache location
    fs_extra_1.default.renameSync(path_1.default.join(targetFolderDir, 'target'), path_1.default.join(cacheEntrypointDirname, 'target'));
    const cacheFiles = await build_utils_1.glob('**/**', cachePath);
    for (const f of Object.keys(cacheFiles)) {
        const accept = /(?:^|\/)target\/release\/\.fingerprint\//.test(f) ||
            /(?:^|\/)target\/release\/build\//.test(f) ||
            /(?:^|\/)target\/release\/deps\//.test(f) ||
            /(?:^|\/)target\/debug\/\.fingerprint\//.test(f) ||
            /(?:^|\/)target\/debug\/build\//.test(f) ||
            /(?:^|\/)target\/debug\/deps\//.test(f);
        if (!accept) {
            delete cacheFiles[f];
        }
    }
    return cacheFiles;
}
exports.prepareCache = prepareCache;
var build_utils_2 = require("@vercel/build-utils");
exports.shouldServe = build_utils_2.shouldServe;
