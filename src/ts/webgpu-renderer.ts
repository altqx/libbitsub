/// <reference types="@webgpu/types" />

import type { SubtitleCompositionData } from './types'

// WGSL Vertex Shader
const VERTEX_SHADER = /* wgsl */ `
struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) texCoord: vec2f,
}

struct Uniforms {
  resolution: vec2f,
}

struct QuadData {
  destRect: vec4f,   // x, y, w, h in pixels
  texSize: vec4f,    // texW, texH, 0, 0
}

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var<storage, read> quadData: QuadData;

// Quad vertices (two triangles)
const QUAD_POSITIONS = array<vec2f, 6>(
  vec2f(0.0, 0.0),
  vec2f(1.0, 0.0),
  vec2f(0.0, 1.0),
  vec2f(1.0, 0.0),
  vec2f(1.0, 1.0),
  vec2f(0.0, 1.0)
);

@vertex
fn vertexMain(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
  var output: VertexOutput;

  let quadPos = QUAD_POSITIONS[vertexIndex];
  let wh = quadData.destRect.zw;

  // Calculate pixel position
  let pixelPos = quadData.destRect.xy + quadPos * wh;

  // Convert to clip space (-1 to 1)
  var clipPos = (pixelPos / uniforms.resolution) * 2.0 - 1.0;
  clipPos.y = -clipPos.y;  // Flip Y for canvas coordinates

  output.position = vec4f(clipPos, 0.0, 1.0);
  output.texCoord = quadPos;

  return output;
}
`

// WGSL Fragment Shader - sample RGBA texture directly
const FRAGMENT_SHADER = /* wgsl */ `
@group(0) @binding(2) var texSampler: sampler;
@group(0) @binding(3) var tex: texture_2d<f32>;

struct FragmentInput {
  @location(0) texCoord: vec2f,
}

@fragment
fn fragmentMain(input: FragmentInput) -> @location(0) vec4f {
  // Sample pre-multiplied alpha texture (premultiplied on CPU upload)
  return textureSample(tex, texSampler, input.texCoord);
}
`

interface TextureInfo {
  texture: GPUTexture
  view: GPUTextureView
  width: number
  height: number
}

/**
 * Check if WebGPU is supported in the current browser.
 */
export function isWebGPUSupported(): boolean {
  return typeof navigator !== 'undefined' && 'gpu' in navigator
}

/**
 * WebGPU-based subtitle renderer.
 * Uploads RGBA bitmap data to GPU textures and renders textured quads.
 */
export class WebGPURenderer {
  device: GPUDevice | null = null
  context: GPUCanvasContext | null = null
  pipeline: GPURenderPipeline | null = null
  sampler: GPUSampler | null = null
  bindGroupLayout: GPUBindGroupLayout | null = null

  // Uniform buffer for resolution
  uniformBuffer: GPUBuffer | null = null

  // Quad data buffers (one per composition)
  quadDataBuffers: GPUBuffer[] = []

  // Textures for compositions
  textures: TextureInfo[] = []
  pendingDestroyTextures: GPUTexture[] = []

  format: GPUTextureFormat = 'bgra8unorm'

  private _canvas: HTMLCanvasElement | null = null
  private _initPromise: Promise<void> | null = null
  private _initialized = false

  /**
   * Initialize the WebGPU renderer.
   * Returns a promise that resolves when initialization is complete.
   */
  async init(): Promise<void> {
    if (this._initPromise) return this._initPromise
    this._initPromise = this._initDevice()
    return this._initPromise
  }

  private async _initDevice(): Promise<void> {
    if (!navigator.gpu) {
      throw new Error('WebGPU not supported')
    }

    const adapter = await navigator.gpu.requestAdapter({
      powerPreference: 'high-performance'
    })

    if (!adapter) {
      throw new Error('No WebGPU adapter found')
    }

    this.device = await adapter.requestDevice()
    this.format = navigator.gpu.getPreferredCanvasFormat()

    // Create shader modules
    const vertexModule = this.device.createShaderModule({
      code: VERTEX_SHADER
    })

    const fragmentModule = this.device.createShaderModule({
      code: FRAGMENT_SHADER
    })

    // Create sampler - use linear filtering for smooth scaling
    this.sampler = this.device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge'
    })

    // Create uniform buffer
    this.uniformBuffer = this.device.createBuffer({
      size: 16, // vec2f resolution + padding
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    })

    // Create bind group layout
    this.bindGroupLayout = this.device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX,
          buffer: { type: 'uniform' }
        },
        {
          binding: 1,
          visibility: GPUShaderStage.VERTEX,
          buffer: { type: 'read-only-storage' }
        },
        {
          binding: 2,
          visibility: GPUShaderStage.FRAGMENT,
          sampler: { type: 'filtering' }
        },
        {
          binding: 3,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: 'float' }
        }
      ]
    })

    // Create pipeline layout
    const pipelineLayout = this.device.createPipelineLayout({
      bindGroupLayouts: [this.bindGroupLayout]
    })

    // Create render pipeline with alpha blending
    this.pipeline = this.device.createRenderPipeline({
      layout: pipelineLayout,
      vertex: {
        module: vertexModule,
        entryPoint: 'vertexMain'
      },
      fragment: {
        module: fragmentModule,
        entryPoint: 'fragmentMain',
        targets: [
          {
            format: this.format,
            blend: {
              color: {
                srcFactor: 'one',
                dstFactor: 'one-minus-src-alpha',
                operation: 'add'
              },
              alpha: {
                srcFactor: 'one',
                dstFactor: 'one-minus-src-alpha',
                operation: 'add'
              }
            }
          }
        ]
      },
      primitive: {
        topology: 'triangle-list'
      }
    })

    this._initialized = true
  }

  /**
   * Configure the canvas for WebGPU rendering.
   */
  async setCanvas(canvas: HTMLCanvasElement, width: number, height: number): Promise<void> {
    await this.init()

    if (!this.device) {
      throw new Error('WebGPU device not initialized')
    }

    this._canvas = canvas

    // Get WebGPU context
    if (!this.context) {
      this.context = canvas.getContext('webgpu')
      if (!this.context) {
        throw new Error('Could not get WebGPU context')
      }

      this.context.configure({
        device: this.device,
        format: this.format,
        alphaMode: 'premultiplied'
      })
    }

    // Update canvas size
    canvas.width = width
    canvas.height = height

    // Update uniform buffer with resolution
    this.device.queue.writeBuffer(this.uniformBuffer!, 0, new Float32Array([width, height]))
  }

  /**
   * Update canvas dimensions.
   */
  updateSize(width: number, height: number): void {
    if (!this.device || !this._canvas) return

    this._canvas.width = width
    this._canvas.height = height

    this.device.queue.writeBuffer(this.uniformBuffer!, 0, new Float32Array([width, height]))
  }

  private createTextureInfo(width: number, height: number): TextureInfo {
    const texture = this.device!.createTexture({
      size: [width, height],
      format: this.format,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT
    })

    return {
      texture,
      view: texture.createView(),
      width,
      height
    }
  }

  /**
   * Render subtitle compositions to the canvas.
   */
  render(
    compositions: SubtitleCompositionData[],
    screenWidth: number,
    screenHeight: number,
    scaleX: number,
    scaleY: number,
    offsetY: number
  ): void {
    if (!this.device || !this.context || !this.pipeline) return

    const commandEncoder = this.device.createCommandEncoder()
    const textureView = this.context.getCurrentTexture().createView()

    // Begin render pass with clear
    const renderPass = commandEncoder.beginRenderPass({
      colorAttachments: [
        {
          view: textureView,
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
          loadOp: 'clear',
          storeOp: 'store'
        }
      ]
    })

    renderPass.setPipeline(this.pipeline)

    // Grow buffers if needed
    while (this.textures.length < compositions.length) {
      this.textures.push(this.createTextureInfo(64, 64))
    }
    while (this.quadDataBuffers.length < compositions.length) {
      this.quadDataBuffers.push(
        this.device.createBuffer({
          size: 32, // 2 x vec4f
          usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
        })
      )
    }

    // Render each composition
    for (let i = 0; i < compositions.length; i++) {
      const comp = compositions[i]
      const { pixelData, x, y } = comp
      const { width, height, data } = pixelData

      if (width <= 0 || height <= 0) continue

      let texInfo = this.textures[i]!

      // Recreate texture if size changed
      if (texInfo.width !== width || texInfo.height !== height) {
        this.pendingDestroyTextures.push(texInfo.texture)
        texInfo = this.createTextureInfo(width, height)
        this.textures[i] = texInfo
      }

      // Premultiply alpha on CPU so linear texture filtering produces correct results
      const uploadData = new Uint8Array(data.length)
      if (this.format === 'bgra8unorm') {
        for (let j = 0; j < data.length; j += 4) {
          const a = data[j + 3]
          const af = a / 255
          uploadData[j] = (data[j + 2] * af + 0.5) | 0 // B <- R * a
          uploadData[j + 1] = (data[j + 1] * af + 0.5) | 0 // G <- G * a
          uploadData[j + 2] = (data[j] * af + 0.5) | 0 // R <- B * a
          uploadData[j + 3] = a
        }
      } else {
        for (let j = 0; j < data.length; j += 4) {
          const a = data[j + 3]
          const af = a / 255
          uploadData[j] = (data[j] * af + 0.5) | 0
          uploadData[j + 1] = (data[j + 1] * af + 0.5) | 0
          uploadData[j + 2] = (data[j + 2] * af + 0.5) | 0
          uploadData[j + 3] = a
        }
      }

      // Upload premultiplied pixel data to texture
      this.device.queue.writeTexture(
        { texture: texInfo.texture },
        uploadData,
        { bytesPerRow: width * 4 },
        { width, height }
      )

      // Calculate scaled position and size
      const scaledWidth = width * scaleX
      const scaledHeight = height * scaleY
      const baseX = x * (this._canvas!.width / screenWidth)
      const baseY = y * (this._canvas!.height / screenHeight)
      const centeredX = baseX + (width * (this._canvas!.width / screenWidth) - scaledWidth) / 2
      const adjustedY = baseY + offsetY + (height * (this._canvas!.height / screenHeight) - scaledHeight)

      // Update quad data buffer
      const quadData = new Float32Array([
        // destRect
        centeredX,
        adjustedY,
        scaledWidth,
        scaledHeight,
        // texSize
        width,
        height,
        0,
        0
      ])

      const quadBuffer = this.quadDataBuffers[i]!
      this.device.queue.writeBuffer(quadBuffer, 0, quadData)

      // Create bind group for this composition
      const bindGroup = this.device.createBindGroup({
        layout: this.bindGroupLayout!,
        entries: [
          { binding: 0, resource: { buffer: this.uniformBuffer! } },
          { binding: 1, resource: { buffer: quadBuffer } },
          { binding: 2, resource: this.sampler! },
          { binding: 3, resource: texInfo.view }
        ]
      })

      renderPass.setBindGroup(0, bindGroup)
      renderPass.draw(6) // 6 vertices for quad
    }

    renderPass.end()
    this.device.queue.submit([commandEncoder.finish()])

    // Destroy old textures after submit
    for (const tex of this.pendingDestroyTextures) {
      tex.destroy()
    }
    this.pendingDestroyTextures = []
  }

  /**
   * Clear the canvas.
   */
  clear(): void {
    if (!this.device || !this.context) return

    const commandEncoder = this.device.createCommandEncoder()
    const textureView = this.context.getCurrentTexture().createView()

    const renderPass = commandEncoder.beginRenderPass({
      colorAttachments: [
        {
          view: textureView,
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
          loadOp: 'clear',
          storeOp: 'store'
        }
      ]
    })

    renderPass.end()
    this.device.queue.submit([commandEncoder.finish()])
  }

  /**
   * Check if renderer is initialized.
   */
  get initialized(): boolean {
    return this._initialized
  }

  /**
   * Destroy all resources.
   */
  destroy(): void {
    for (const tex of this.textures) {
      tex.texture.destroy()
    }
    this.textures = []

    for (const tex of this.pendingDestroyTextures) {
      tex.destroy()
    }
    this.pendingDestroyTextures = []

    this.uniformBuffer?.destroy()
    for (const buf of this.quadDataBuffers) {
      buf.destroy()
    }
    this.quadDataBuffers = []

    this.device?.destroy()
    this.device = null
    this.context = null
    this._canvas = null
    this._initialized = false
    this._initPromise = null
  }
}
