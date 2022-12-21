"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const execa_1 = __importDefault(require("execa"));
const build_utils_1 = require("@vercel/build-utils");
async function downloadRustToolchain(version = 'stable') {
    build_utils_1.debug('Downloading the rust toolchain');
    try {
        await execa_1.default(`curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain ${version}`, [], { shell: true, stdio: 'inherit' });
    }
    catch (err) {
        throw new Error(`Failed to install rust via rustup: ${err.message}`);
    }
}
exports.installRustAndFriends = async (version) => {
    try {
        await execa_1.default(`rustup -V`, [], { shell: true, stdio: 'ignore' });
        build_utils_1.debug('Rust already exists');
    }
    catch (err) {
        await downloadRustToolchain(version);
    }
};
