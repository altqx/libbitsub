//! DVB Subtitling (ETSI EN 300 743) parsing and rendering.
//!
//! Supports demuxed PES/ES payloads and libbitsub `"DV"` PTS-framed dumps.

mod clut;
mod context;
mod parser;
mod pes;
mod rle;
mod segment;

pub(crate) const MAX_DVB_BITMAP_PIXELS: usize = 16_777_216;
pub(crate) const DEFAULT_SCREEN_WIDTH: u16 = 720;
pub(crate) const DEFAULT_SCREEN_HEIGHT: u16 = 576;

pub use clut::*;
pub use context::*;
pub use parser::*;
pub use pes::*;
pub use rle::*;
pub use segment::*;
