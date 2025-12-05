/**
 * Utility functions for libbitsub.
 */

import type { SubtitleData, SubtitleCompositionData, FrameData, WorkerRendererState } from './types';
import { isWorkerAvailable } from './worker';

/** Binary search for timestamp index. */
export function binarySearchTimestamp(timestamps: Float64Array, timeMs: number): number {
    if (timestamps.length === 0) return -1;
    
    let left = 0;
    let right = timestamps.length - 1;
    let result = -1;
    
    while (left <= right) {
        const mid = Math.floor((left + right) / 2);
        if (timestamps[mid] <= timeMs) {
            result = mid;
            left = mid + 1;
        } else {
            right = mid - 1;
        }
    }
    
    return result;
}

/** Convert worker frame data to SubtitleData. */
export function convertFrameData(frame: FrameData): SubtitleData {
    const compositionData: SubtitleCompositionData[] = frame.compositions.map(comp => {
        const clampedData = new Uint8ClampedArray(comp.rgba.length);
        clampedData.set(comp.rgba);
        return {
            pixelData: new ImageData(clampedData, comp.width, comp.height),
            x: comp.x,
            y: comp.y,
        };
    });
    
    return { width: frame.width, height: frame.height, compositionData };
}

/** Create initial worker state. */
export function createWorkerState(): WorkerRendererState {
    return {
        useWorker: isWorkerAvailable(),
        workerReady: false,
        timestamps: new Float64Array(0),
        frameCache: new Map(),
        pendingRenders: new Map(),
    };
}
