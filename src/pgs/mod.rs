//! PGS (Presentation Graphic Stream) subtitle format parsing and rendering.
//!
//! This module implements the Blu-ray PGS subtitle format (.sup files).

mod composition;
mod display_set;
mod object;
mod palette;
mod parser;
mod rle;
mod segment;
mod window;

pub(crate) const MAX_PGS_OBJECT_DATA_LEN: usize = 0x00FF_FFFF;
pub(crate) const MAX_PGS_BITMAP_PIXELS: usize = 16_777_216;

pub use composition::*;
pub use display_set::*;
pub use object::*;
pub use palette::*;
pub use parser::*;
pub use rle::*;
pub use segment::*;
pub use window::*;
