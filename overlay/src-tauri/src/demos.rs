// Demo discovery for the in-app demo loader.
//
// Finds the CS2 `…/game/csgo` directory across Steam libraries and lists the
// `.dem` files in `csgo/` and `csgo/replays/`. Each demo carries the argument
// you pass to `playdemo` (relative to `csgo/`), so the UI can load it in one tap.
// Windows-focused — that's where CS2 + HLAE run.

use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

#[derive(serde::Serialize, Clone)]
pub struct DemoInfo {
    pub file: String,    // file name incl. .dem
    pub arg: String,     // playdemo argument, relative to csgo/ (forward slashes)
    pub map: String,     // parsed map prefix (e.g. "de_nuke"), or "" if none
    pub size_mb: f64,
    pub modified: i64,   // unix seconds (0 if unknown)
}

/// Public entry point: every demo we can find, newest first.
pub fn list() -> Vec<DemoInfo> {
    let mut out: Vec<DemoInfo> = Vec::new();
    let mut seen: Vec<String> = Vec::new();
    for csgo in csgo_dirs() {
        scan_into(&csgo, "", &mut out, &mut seen);
        scan_into(&csgo.join("replays"), "replays/", &mut out, &mut seen);
    }
    out.sort_by(|a, b| b.modified.cmp(&a.modified));
    out
}

fn scan_into(dir: &Path, prefix: &str, out: &mut Vec<DemoInfo>, seen: &mut Vec<String>) {
    let rd = match fs::read_dir(dir) {
        Ok(r) => r,
        Err(_) => return,
    };
    for entry in rd.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let name = match path.file_name().and_then(|n| n.to_str()) {
            Some(n) => n.to_string(),
            None => continue,
        };
        if !name.to_ascii_lowercase().ends_with(".dem") {
            continue;
        }
        let stem = &name[..name.len() - 4];
        let arg = format!("{prefix}{stem}");
        if seen.iter().any(|s| s == &arg) {
            continue;
        }
        seen.push(arg.clone());
        let meta = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        let modified = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        // Map from the filename if it's there; otherwise read it out of the
        // demo header (GOTV auto-demos like match730_… have no map prefix).
        let mut map = parse_map(&name);
        if map.is_empty() {
            if let Some(m) = map_from_header(&path) {
                map = m;
            }
        }
        out.push(DemoInfo {
            map,
            file: name,
            arg,
            size_mb: (meta.len() as f64) / 1_048_576.0,
            modified,
        });
    }
}

/// Pull a map name out of a demo filename like `de_nuke__match730_…`.
fn parse_map(file: &str) -> String {
    if let Some(idx) = file.find("__") {
        let pre = &file[..idx];
        const PREFIXES: [&str; 6] = ["de_", "cs_", "ar_", "dz_", "gd_", "lobby_mapveto"];
        if PREFIXES.iter().any(|p| pre.starts_with(p)) {
            return pre.to_string();
        }
    }
    String::new()
}

/// Locate every existing `…/game/csgo` directory across Steam libraries.
pub fn csgo_dirs() -> Vec<PathBuf> {
    let mut libs: Vec<PathBuf> = Vec::new();

    // Parse libraryfolders.vdf from the standard Steam install locations — this
    // is what lists secondary libraries (e.g. a D:\SteamLibrary).
    for steam in [
        r"C:\Program Files (x86)\Steam",
        r"C:\Program Files\Steam",
    ] {
        let steam = PathBuf::from(steam);
        for lib in parse_library_vdf(&steam) {
            push_unique(&mut libs, lib);
        }
        push_unique(&mut libs, steam);
    }

    // Bare library roots on common drives, as a fallback if the vdf is missing.
    for drive in ['C', 'D', 'E', 'F', 'G'] {
        for name in ["SteamLibrary", "Steam", "Games\\Steam"] {
            push_unique(&mut libs, PathBuf::from(format!("{drive}:\\{name}")));
        }
    }

    let mut out: Vec<PathBuf> = Vec::new();
    for lib in libs {
        let csgo = lib.join("steamapps/common/Counter-Strike Global Offensive/game/csgo");
        if csgo.is_dir() {
            push_unique(&mut out, csgo);
        }
    }
    out
}

/// Read a Steam install's libraryfolders.vdf and return the library `"path"`s.
fn parse_library_vdf(steam_root: &Path) -> Vec<PathBuf> {
    let vdf = steam_root.join("steamapps/libraryfolders.vdf");
    let text = match fs::read_to_string(&vdf) {
        Ok(t) => t,
        Err(_) => return Vec::new(),
    };
    let mut out = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        if let Some(rest) = line.strip_prefix("\"path\"") {
            // rest is like:  \t\t"D:\\SteamLibrary"
            if let Some(start) = rest.find('"') {
                if let Some(end) = rest[start + 1..].find('"') {
                    let raw = &rest[start + 1..start + 1 + end];
                    out.push(PathBuf::from(raw.replace("\\\\", "\\")));
                }
            }
        }
    }
    out
}

fn push_unique(v: &mut Vec<PathBuf>, p: PathBuf) {
    if !v.iter().any(|x| x == &p) {
        v.push(p);
    }
}

/* ----------------------------------------------------- read map from header */

/// Read the map name out of a demo file's header.
/// CS2 (`PBDEMS2`) stores it as `map_name` (field 5) in the first command, a
/// `CDemoFileHeader` protobuf. Source-1 (`HL2DEMO`) keeps it at a fixed offset.
fn map_from_header(path: &Path) -> Option<String> {
    let mut file = fs::File::open(path).ok()?;
    let mut buf = [0u8; 4096];
    let n = file.read(&mut buf).ok()?;
    let buf = &buf[..n];
    if buf.len() < 16 {
        return None;
    }
    if &buf[0..8] == b"PBDEMS2\0" {
        return cs2_map(buf);
    }
    if &buf[0..8] == b"HL2DEMO\0" {
        // Source 1: char mapName[260] at offset 536.
        let start = 536;
        if buf.len() >= start + 260 {
            let s = cstr(&buf[start..start + 260]);
            if !s.is_empty() {
                return Some(s);
            }
        }
    }
    None
}

/// Parse the CS2 header packet (DEM_FileHeader = 1) and pull out map_name.
fn cs2_map(buf: &[u8]) -> Option<String> {
    // The command stream starts a few bytes past the magic; try the known
    // offsets and validate we actually landed on DEM_FileHeader.
    for start in [8usize, 16] {
        if start >= buf.len() {
            continue;
        }
        let mut data = &buf[start..];
        let cmd = read_varint(&mut data)?;
        let _tick = read_varint(&mut data)?;
        let size = read_varint(&mut data)? as usize;
        if cmd & 0x40 != 0 || (cmd & !0x40) != 1 {
            continue; // compressed, or not the file header → wrong offset
        }
        if size == 0 || size > data.len() {
            continue;
        }
        if let Some(m) = pb_string_field(&data[..size], 5) {
            if !m.is_empty() {
                return Some(m);
            }
        }
    }
    None
}

/// Find a length-delimited (string) protobuf field by number, skipping the rest.
fn pb_string_field(mut data: &[u8], want: u64) -> Option<String> {
    while !data.is_empty() {
        let tag = read_varint(&mut data)?;
        let field = tag >> 3;
        match tag & 7 {
            0 => {
                read_varint(&mut data)?; // varint
            }
            1 => {
                if data.len() < 8 {
                    return None;
                }
                data = &data[8..]; // 64-bit
            }
            5 => {
                if data.len() < 4 {
                    return None;
                }
                data = &data[4..]; // 32-bit
            }
            2 => {
                let len = read_varint(&mut data)? as usize;
                if data.len() < len {
                    return None;
                }
                let (bytes, rest) = data.split_at(len);
                data = rest;
                if field == want {
                    return std::str::from_utf8(bytes).ok().map(|s| s.trim().to_string());
                }
            }
            _ => return None,
        }
    }
    None
}

/// Protobuf/LEB128 varint.
fn read_varint(data: &mut &[u8]) -> Option<u64> {
    let mut result: u64 = 0;
    let mut shift = 0;
    loop {
        let byte = *data.first()?;
        *data = &data[1..];
        result |= ((byte & 0x7f) as u64) << shift;
        if byte & 0x80 == 0 {
            return Some(result);
        }
        shift += 7;
        if shift >= 64 {
            return None;
        }
    }
}

/// Null-terminated ASCII out of a fixed buffer.
fn cstr(raw: &[u8]) -> String {
    let end = raw.iter().position(|&b| b == 0).unwrap_or(raw.len());
    String::from_utf8_lossy(&raw[..end]).trim().to_string()
}
