//! # libbitsub
//!
//! High-performance WASM renderer for graphical subtitles (PGS and VobSub).
//!
//! This library provides a Rust-based rendering engine compiled to WebAssembly
//! for efficient subtitle decoding and rendering in web browsers.

mod pgs;
mod renderer;
mod utils;
mod vobsub;

use wasm_bindgen::prelude::*;

// When the `wee_alloc` feature is enabled, use `wee_alloc` as the global allocator.
#[cfg(feature = "wee_alloc")]
#[global_allocator]
static ALLOC: wee_alloc::WeeAlloc = wee_alloc::WeeAlloc::INIT;

/// Initialize the WASM module. Call this once before using other functions.
#[wasm_bindgen(start)]
pub fn init() {
    // Set up better error messages for panics in debug builds
    #[cfg(feature = "console_error_panic_hook")]
    console_error_panic_hook::set_once();
}

// Re-export main types
pub use pgs::*;
pub use renderer::*;
pub use vobsub::*;
