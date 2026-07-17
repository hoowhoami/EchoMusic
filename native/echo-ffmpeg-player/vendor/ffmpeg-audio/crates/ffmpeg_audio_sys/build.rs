use std::{
    env,
    path::PathBuf,
};

mod utils {
    use std::{
        env,
        fs,
        io::{
            self,
        },
        path::Path,
    };

    #[rustfmt::skip]
    #[allow(clippy::match_same_arms)]
    pub fn get_config_dir_name() -> String {
        if let Ok(override_dir) = env::var("FFMPEG_CUSTOM_CONFIG") {
            return override_dir;
        }

        let os = env::var("CARGO_CFG_TARGET_OS").expect("CARGO_CFG_TARGET_OS not set");
        let arch = env::var("CARGO_CFG_TARGET_ARCH").expect("CARGO_CFG_TARGET_ARCH not set");
        let target_env = env::var("CARGO_CFG_TARGET_ENV").unwrap_or_default();
        let target_abi = env::var("CARGO_CFG_TARGET_ABI").unwrap_or_default();

        let matched_dir = match (os.as_str(), arch.as_str(), target_env.as_str(), target_abi.as_str()) {
            ("windows", "aarch64", "msvc", _) => "build_out_windows_arm64",
            ("windows", "x86_64", "msvc", _)  => "build_out_windows_x86_64",
            ("windows", "x86", "msvc", _)     => "build_out_windows_x86",

            ("windows", "aarch64", "gnu" | "gnullvm", _) => "build_out_windows-gnu_aarch64",
            ("windows", "x86_64", "gnu" | "gnullvm", _)  => "build_out_windows-gnu_x86_64",
            ("windows", "x86", "gnu" | "gnullvm", _)     => "build_out_windows-gnu_x86",
            ("windows", "arm", "gnu" | "gnullvm", _)     => "build_out_windows-gnu_arm",
            ("windows", _, _, _)                         => "build_out_windows_x86_64",

            ("android", "aarch64", _, _) => "build_out_android_arm64-v8a",
            ("android", "arm", _, _)     => "build_out_android_armeabi-v7a",
            ("android", "x86", _, _)     => "build_out_android_x86",
            ("android", "x86_64", _, _)  => "build_out_android_x86_64",

            ("macos", "aarch64", _, _) => "build_out_macos_arm64",
            ("macos", "x86_64", _, _)  => "build_out_macos_x86_64",

            ("ios" | "tvos" | "watchos" | "visionos", "x86_64", _, _) => "build_out_macos_x86_64",
            ("ios" | "tvos" | "watchos" | "visionos", "aarch64", _, "sim" | "macabi") => "build_out_macos_arm64",
            ("ios" | "tvos" | "watchos" | "visionos", "aarch64", _, _) => "build_out_ios_arm64",

            ("linux" | "freebsd" | "netbsd" | "openbsd" | "dragonfly" | "illumos" | "solaris" | "fuchsia" | "redox", "aarch64", _, _) => "build_out_linux_arm64",
            ("linux" | "freebsd" | "netbsd" | "openbsd" | "dragonfly" | "illumos" | "solaris" | "fuchsia" | "redox", "x86_64", _, _)  => "build_out_linux_x86_64",
            ("linux" | "freebsd" | "netbsd" | "openbsd" | "dragonfly" | "illumos" | "solaris" | "fuchsia" | "redox", "x86", _, _)     => "build_out_linux_x86",
            ("linux" | "freebsd" | "netbsd" | "openbsd" | "dragonfly" | "illumos" | "solaris" | "fuchsia" | "redox", "arm", _, _)     => "build_out_linux_armv7",

            ("none" | "unknown", _, _, _) => panic!("Bare-metal or unknown OS targets are not supported."),

            ("emscripten" | "wasi", "wasm32", _, _) => "build_out_emscripten_wasm32",

            (u_os, u_arch, u_env, u_abi) => {
                println!("cargo:warning=[ffmpeg_audio_sys] Current build target {u_os}-{u_arch}-{u_env}-{u_abi} is not supported");
                println!("cargo:warning=This crate does not contain a compilation configuration for the specified target. Falling back to the linux_x86_64 configuration");
                println!("cargo:warning=This may result in compilation failure or unexpected behavior");
                println!("cargo:warning=");
                println!("cargo:warning=Suggestions:");
                println!("cargo:warning=  1. Set the FFMPEG_CUSTOM_CONFIG environment variable to provide an external/internal configuration directory that exactly matches this architecture");
                println!("cargo:warning=  2. Discard the built-in FFmpeg in this crate and use the FFmpeg development libraries on your system");
                "build_out_linux_x86_64"
            }
        };

        matched_dir.to_string()
    }

    pub fn extract_zip(zip_path: &Path, dest: &Path) -> io::Result<()> {
        let file = fs::File::open(zip_path)?;
        let mut archive = zip::ZipArchive::new(file)
            .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;

        for i in 0..archive.len() {
            let mut entry = archive
                .by_index(i)
                .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;

            let out_path = match entry.enclosed_name() {
                Some(path) => dest.join(path),
                None => {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidData,
                        format!("ZIP entry contains an invalid path: {}", entry.name()),
                    ));
                }
            };

            if entry.is_dir() {
                fs::create_dir_all(&out_path)?;
            } else {
                if let Some(parent) = out_path.parent() {
                    fs::create_dir_all(parent)?;
                }
                let mut out_file = fs::File::create(&out_path)?;
                io::copy(&mut entry, &mut out_file)?;
            }
        }
        Ok(())
    }

    pub fn emit_link_libs() {
        let target_os = env::var("CARGO_CFG_TARGET_OS").unwrap();

        match target_os.as_str() {
            "android" => {
                println!("cargo:rustc-link-lib=m");
            }
            "linux" | "macos" | "ios" | "tvos" | "watchos" | "visionos" | "freebsd" | "netbsd"
            | "openbsd" | "dragonfly" | "illumos" | "solaris" | "fuchsia" | "redox" => {
                println!("cargo:rustc-link-lib=m");
                println!("cargo:rustc-link-lib=pthread");
            }
            "windows" => {
                println!("cargo:rustc-link-lib=bcrypt");
            }
            _ => {}
        }
    }

    pub fn create_base_bindings() -> bindgen::Builder {
        bindgen::Builder::default()
            .header("wrapper.h")
            .parse_callbacks(Box::new(bindgen::CargoCallbacks::new()))
            .allowlist_function("av_.*")
            .allowlist_function("avformat_.*")
            .allowlist_function("avcodec_.*")
            .allowlist_function("avio_.*")
            .allowlist_function("swr_.*")
            .allowlist_type("AV.*")
            .allowlist_type("Swr.*")
            .allowlist_var("AV_.*")
            .allowlist_var("AVERROR_.*")
            .allowlist_var("AVFMT_.*")
            .allowlist_var("AVSEEK.*")
    }
}

mod bundled {
    use std::{
        collections::BTreeSet,
        env,
        fs,
        path::{
            Path,
            PathBuf,
        },
    };

    use crate::utils;

    fn parse_log_line(
        line: &str,
        ffmpeg_dir: &Path,
        defines: &mut BTreeSet<(String, Option<String>)>,
        includes: &mut BTreeSet<String>,
        c_files: &mut BTreeSet<String>,
    ) {
        if (line.contains("-c -o ") || line.contains("-c -Fo")) && line.contains(".c") {
            let parts: Vec<&str> = line.split_whitespace().collect();
            for &part in &parts {
                if part.starts_with("-D") && !part.starts_with("-DBUILDING_") {
                    let define = &part[2..];
                    if let Some((k, v)) = define.split_once('=') {
                        defines.insert((k.to_string(), Some(v.to_string())));
                    } else {
                        defines.insert((define.to_string(), None));
                    }
                } else if let Some(inc) = part.strip_prefix("-I") {
                    if inc == "." {
                        continue;
                    }
                    for sep in ["ffmpeg/", "ffmpeg\\"] {
                        if let Some(idx) = inc.find(sep) {
                            let rel = &inc[idx + sep.len()..];
                            if !rel.is_empty() {
                                includes
                                    .insert(ffmpeg_dir.join(rel).to_string_lossy().into_owned());
                            }
                            break;
                        }
                    }
                } else if Path::new(part)
                    .extension()
                    .is_some_and(|ext| ext.eq_ignore_ascii_case("c"))
                    && let Some(idx) = part.find("libav").or_else(|| part.find("libsw"))
                {
                    c_files.insert(part[idx..].replace('\\', "/"));
                }
            }
        }
    }

    struct BuildMeta {
        c_files: BTreeSet<String>,
        defines: BTreeSet<(String, Option<String>)>,
        includes: BTreeSet<String>,
    }

    pub fn build(manifest_dir: &Path, out_dir: &Path) -> Result<(), Box<dyn std::error::Error>> {
        let os = env::var("CARGO_CFG_TARGET_OS").expect("CARGO_CFG_TARGET_OS not set");
        let target_env = env::var("CARGO_CFG_TARGET_ENV").unwrap_or_default();

        let (ffmpeg_dir, configs_base) = prepare_sources(manifest_dir, out_dir)?;
        let (build_meta, config_dir) = parse_compiler_meta(&ffmpeg_dir, &configs_base)?;

        compile_ffmpeg_audio(&ffmpeg_dir, &config_dir, &build_meta, &os, &target_env);
        generate_bindings(&ffmpeg_dir, &config_dir, &build_meta, out_dir)?;

        Ok(())
    }

    fn prepare_sources(
        manifest_dir: &Path,
        out_dir: &Path,
    ) -> Result<(PathBuf, PathBuf), Box<dyn std::error::Error>> {
        let vendor_ffmpeg = manifest_dir.join("vendor").join("ffmpeg_slim");
        let vendor_configs = manifest_dir.join("vendor").join("configs");

        if vendor_ffmpeg.exists() && vendor_configs.exists() {
            println!("cargo:rerun-if-changed=vendor/ffmpeg_slim");
            println!("cargo:rerun-if-changed=vendor/configs");
            Ok((vendor_ffmpeg, vendor_configs))
        } else {
            let slim_zip = manifest_dir.join("vendor").join("ffmpeg_slim.zip");
            let configs_zip = manifest_dir.join("vendor").join("configs.zip");

            println!("cargo:rerun-if-changed=vendor/ffmpeg_slim.zip");
            println!("cargo:rerun-if-changed=vendor/configs.zip");

            let ffmpeg_dir = out_dir.join("ffmpeg_slim");
            let configs_base = out_dir.join("configs");

            if !ffmpeg_dir.exists() {
                utils::extract_zip(&slim_zip, &ffmpeg_dir)
                    .map_err(|e| format!("Failed to extract ffmpeg_slim.zip: {e}"))?;
            }
            if !configs_base.exists() {
                utils::extract_zip(&configs_zip, &configs_base)
                    .map_err(|e| format!("Failed to extract configs.zip: {e}"))?;
            }
            Ok((ffmpeg_dir, configs_base))
        }
    }

    fn parse_compiler_meta(
        ffmpeg_dir: &Path,
        configs_base: &Path,
    ) -> Result<(BuildMeta, PathBuf), Box<dyn std::error::Error>> {
        let config_dir_name = utils::get_config_dir_name();
        let config_dir = configs_base.join(config_dir_name);
        let log_path = config_dir.join("make_dryrun.log");

        println!("cargo:rerun-if-changed={}", log_path.display());

        let log_content = fs::read_to_string(&log_path).map_err(|_| {
            format!(
                "Failed to read the log file: {}.\nPlease ensure the configuration for this target platform is included in configs.zip.",
                log_path.display()
            )
        })?;

        let mut c_files = BTreeSet::new();
        let mut defines = BTreeSet::new();
        let mut includes = BTreeSet::new();

        for line in log_content.lines() {
            parse_log_line(line, ffmpeg_dir, &mut defines, &mut includes, &mut c_files);
        }

        Ok((
            BuildMeta {
                c_files,
                defines,
                includes,
            },
            config_dir,
        ))
    }

    fn compile_ffmpeg_audio(
        ffmpeg_dir: &Path,
        config_dir: &Path,
        meta: &BuildMeta,
        os: &str,
        target_env: &str,
    ) {
        let mut build = cc::Build::new();

        build.include(ffmpeg_dir);
        build.include(config_dir);
        build.include(ffmpeg_dir.join("libavcodec"));
        build.include(ffmpeg_dir.join("libavformat"));
        build.include(ffmpeg_dir.join("libswresample"));

        for inc in &meta.includes {
            build.include(inc);
        }
        for (k, v) in &meta.defines {
            build.define(k, v.as_deref());
        }
        for file in &meta.c_files {
            build.file(ffmpeg_dir.join(file));
        }

        if os == "windows" && target_env == "msvc" {
            build.flag("/utf-8");
        }
        if os == "emscripten" {
            build.flag("-fPIC");
            build.flag("-msimd128");
        }
        build.warnings(false);
        build.compile("ffmpeg_audio");

        utils::emit_link_libs();
    }

    fn generate_bindings(
        ffmpeg_dir: &Path,
        config_dir: &Path,
        meta: &BuildMeta,
        out_dir: &Path,
    ) -> Result<(), Box<dyn std::error::Error>> {
        println!("cargo:rerun-if-changed=wrapper.h");

        let mut builder = utils::create_base_bindings()
            .clang_arg(format!("-I{}", ffmpeg_dir.display()))
            .clang_arg(format!("-I{}", config_dir.display()));

        let target = env::var("TARGET")?;
        builder = builder.clang_arg(format!("--target={target}"));

        if env::var("CARGO_CFG_TARGET_OS").unwrap_or_default() == "emscripten" {
            builder = configure_emscripten(builder);
        }

        for inc in &meta.includes {
            builder = builder.clang_arg(format!("-I{inc}"));
        }
        for (k, v) in &meta.defines {
            builder = builder.clang_arg(
                v.as_deref()
                    .map_or_else(|| format!("-D{k}"), |val| format!("-D{k}={val}")),
            );
        }

        let bindings = builder
            .generate()
            .map_err(|_| "Failed to generate FFmpeg bindings")?;
        bindings
            .write_to_file(out_dir.join("bindings.rs"))
            .map_err(|_| "Failed to write bindings.rs")?;

        Ok(())
    }

    fn configure_emscripten(mut builder: bindgen::Builder) -> bindgen::Builder {
        // Clang defaults to hidden visibility for the wasm32 target, which
        // causes bindgen to silently skip all extern function declarations.
        // Overriding to "default" restores normal linkage visibility so that
        // bindgen emits the expected `extern "C"` function blocks.
        builder = builder.clang_arg("-fvisibility=default");

        // Emscripten uses musl libc which lacks glibc's __UINT8_C / __UINT16_C / __UINT64_C macros.
        let sysroot_macros = [
            "-D__UINT8_C(c)=c",
            "-D__UINT16_C(c)=c",
            "-D__UINT32_C(c)=c ## U",
            "-D__UINT64_C(c)=c ## ULL",
            "-D__INT8_C(c)=c",
            "-D__INT16_C(c)=c",
            "-D__INT32_C(c)=c",
            "-D__INT64_C(c)=c ## LL",
            "-D__INTMAX_C(c)=c ## LL",
            "-D__UINTMAX_C(c)=c ## ULL",
            "-D__SIZE_C(c)=c ## UL",
            "-D__PTRDIFF_C(c)=c ## L",
        ];

        for &marg in &sysroot_macros {
            builder = builder.clang_arg(marg);
        }

        if let Ok(emsdk) = env::var("EMSDK") {
            let sysroot = format!("{emsdk}/upstream/emscripten/cache/sysroot");
            builder = builder.clang_arg(format!("--sysroot={sysroot}"));
        } else {
            println!(
                "cargo:warning=EMSDK environment variable not detected, bindgen may fail to find header files"
            );
        }

        builder
    }
}

mod system {
    use std::path::{
        Path,
        PathBuf,
    };

    use crate::utils;

    const REQUIRED_LIBS: [&str; 4] = ["libavcodec", "libavformat", "libavutil", "libswresample"];

    pub fn build(out_dir: &Path, target_os: &str) {
        println!("cargo:warning=ffmpeg_slim.zip not found, attempting to find an installed FFmpeg");
        println!("cargo:rerun-if-changed=wrapper.h");

        let mut include_paths: Vec<PathBuf> = Vec::new();

        if target_os == "windows" {
            let vcpkg_libs = ["avcodec", "avformat", "avutil", "swresample"];
            let mut all_found = true;
            for lib in &vcpkg_libs {
                if let Ok(library) = vcpkg::Config::new().emit_includes(true).probe(lib) {
                    include_paths.extend(library.include_paths);
                } else {
                    all_found = false;
                    break;
                }
            }
            if !all_found {
                include_paths.clear();
            }
        }

        if include_paths.is_empty() {
            for lib in &REQUIRED_LIBS {
                let library = pkg_config::Config::new()
                    .atleast_version("61.0")
                    .probe(lib)
                    .unwrap_or_else(|e| panic!("Failed to find {lib}: {e} "));
                include_paths.extend(library.include_paths);
            }
        }

        include_paths.sort();
        include_paths.dedup();

        let mut builder = utils::create_base_bindings();

        for path in include_paths {
            builder = builder.clang_arg(format!("-I{}", path.display()));
        }

        let bindings = builder
            .generate()
            .expect("Failed to generate FFmpeg bindings");
        bindings
            .write_to_file(out_dir.join("bindings.rs"))
            .expect("Failed to write bindings.rs");
    }
}

fn main() {
    let target_os = env::var("CARGO_CFG_TARGET_OS").unwrap();
    let out_dir = PathBuf::from(env::var("OUT_DIR").unwrap());
    let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());
    let build_mode = env::var("FFMPEG_MODE").unwrap_or_else(|_| "bundled".to_string());
    println!("cargo:rerun-if-env-changed=FFMPEG_MODE");
    println!("cargo:rerun-if-env-changed=FFMPEG_CUSTOM_CONFIG");

    let slim_zip = manifest_dir.join("vendor").join("ffmpeg_slim.zip");
    let vendor_ffmpeg = manifest_dir.join("vendor").join("ffmpeg_slim");
    let vendor_configs = manifest_dir.join("vendor").join("configs");

    let has_bundled_files =
        slim_zip.exists() || (vendor_ffmpeg.exists() && vendor_configs.exists());

    match build_mode.to_lowercase().as_str() {
        "system" => {
            system::build(&out_dir, &target_os);
        }
        "bundled" => {
            if has_bundled_files {
                bundled::build(&manifest_dir, &out_dir).expect("Error building built-in FFmpeg");
            } else {
                println!(
                    "cargo:warning=[ffmpeg_audio_sys] ffmpeg_slim artifacts not found in the vendor directory"
                );
                println!("cargo:warning=Falling back to attempting to link the system's FFmpeg");
                println!(
                    "cargo:warning=If you wish to use the built-in FFmpeg, please ensure configs.zip and ffmpeg_slim.zip exist"
                );
                system::build(&out_dir, &target_os);
            }
        }
        _ => {
            panic!(
                "Unknown FFMPEG_MODE: '{build_mode}'. Supported values are 'bundled' or 'system'"
            );
        }
    }
}
