//! VobSub (DVD subtitle) format parsing and rendering.
//!
//! This module implements the VobSub subtitle format (.idx + .sub files).

mod deband;
mod idx_parser;
mod mks_parser;
mod rle;
mod sub_parser;
mod vobsub_parser;

pub(crate) const MAX_VOBSUB_IMAGE_PIXELS: usize = 16_777_216;

pub use deband::*;

pub use idx_parser::*;
pub use mks_parser::*;
pub use rle::*;
pub use sub_parser::*;
pub use vobsub_parser::*;
