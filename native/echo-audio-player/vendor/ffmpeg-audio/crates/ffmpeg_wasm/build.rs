use std::env;

fn main() {
    let target_os = env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    if target_os != "emscripten" {
        return;
    }

    let manifest_dir = env::var("CARGO_MANIFEST_DIR").unwrap();
    let js_library = format!("{manifest_dir}/library_ffmpeg.js");

    let exports = [
        "_main",
        "_malloc",
        "_free",
        "_wasm_decoder_create",
        "_wasm_decoder_destroy",
        "_wasm_decoder_decode_frame",
        "_wasm_decoder_get_frame_samples",
        "_wasm_decoder_get_channel_ptr",
        "_wasm_decoder_seek",
        "_wasm_decoder_get_duration",
        "_wasm_decoder_get_metadata_json",
        "_wasm_decoder_get_cover_ptr",
        "_wasm_decoder_get_cover_size",
        "_wasm_decoder_get_cover_mime",
        "_wasm_decoder_set_compute_peaks",
        "_wasm_decoder_get_frame_min",
        "_wasm_decoder_get_frame_max",
        "_wasm_get_last_error",
    ];
    let exports_json = serde_json::to_string(&exports).unwrap();

    let runtime_methods = [
        "getValue",
        "setValue",
        "UTF8ToString",
        "wasmMemory",
        "HEAP8",
        "HEAPU8",
        "HEAP16",
        "HEAPU16",
        "HEAP32",
        "HEAPU32",
        "HEAPF32",
        "HEAPF64",
        "HEAP64",
        "HEAPU64",
    ];
    let runtime_json = serde_json::to_string(&runtime_methods).unwrap();

    let link_args = [
        "-sEXPORT_NAME=createFFmpegAudio".into(),
        format!("--js-library={js_library}"),
        "-sALLOW_MEMORY_GROWTH=1".into(),
        format!("-sEXPORTED_FUNCTIONS={exports_json}"),
        format!("-sEXPORTED_RUNTIME_METHODS={runtime_json}"),
        "-sNO_EXIT_RUNTIME=1".into(),
        "-O3".into(),
        "-g2".into(),
        "-flto=full".into(),
        "-sFILESYSTEM=0".into(),
        "-sINCOMING_MODULE_JS_API=['locateFile']".into(),
    ];

    for arg in &link_args {
        println!("cargo:rustc-link-arg={arg}");
    }
}
