fn main() {
    napi_build::setup();

    #[cfg(target_os = "linux")]
    {
        use std::{env, fs, path::PathBuf};

        let out_dir = PathBuf::from(env::var_os("OUT_DIR").expect("OUT_DIR should be set"));
        let exports = out_dir.join("echo-ffmpeg-player.exports");
        fs::write(
            &exports,
            b"{\n  global:\n    napi_register_module_v1;\n  local:\n    *;\n};\n",
        )
        .expect("failed to write Linux export map");

        println!(
            "cargo:rustc-link-arg-cdylib=-Wl,--version-script={}",
            exports.display()
        );
    }
}
