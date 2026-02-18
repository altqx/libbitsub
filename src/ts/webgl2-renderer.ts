import type { SubtitleCompositionData } from './types'

// GLSL ES 3.00 Vertex Shader
// Uses gl_VertexID to generate unit-quad positions without a vertex buffer
const VERTEX_SHADER_SRC = /* glsl */ `#version 300 es

uniform vec2 u_resolution;
uniform vec4 u_destRect; // x, y, w, h in pixels

out vec2 v_texCoord;

void main() {
  // Generate unit-square positions for two-triangle quad (CCW)
  vec2 unitPos;
  if (gl_VertexID == 0) unitPos = vec2(0.0, 0.0);
  else if (gl_VertexID == 1) unitPos = vec2(1.0, 0.0);
  else if (gl_VertexID == 2) unitPos = vec2(0.0, 1.0);
  else if (gl_VertexID == 3) unitPos = vec2(1.0, 0.0);
  else if (gl_VertexID == 4) unitPos = vec2(1.0, 1.0);
  else                       unitPos = vec2(0.0, 1.0);

  v_texCoord = unitPos;

  // Convert pixel position to clip space
  vec2 pixelPos = u_destRect.xy + unitPos * u_destRect.zw;
  vec2 clipPos = (pixelPos / u_resolution) * 2.0 - 1.0;
  clipPos.y = -clipPos.y; // Flip Y for canvas coordinates

  gl_Position = vec4(clipPos, 0.0, 1.0);
}
`

// GLSL ES 3.00 Fragment Shader - sample RGBA texture directly
const FRAGMENT_SHADER_SRC = /* glsl */ `#version 300 es
precision mediump float;

uniform sampler2D u_texture;

in vec2 v_texCoord;
out vec4 outColor;

void main() {
  // Texture is pre-multiplied alpha; output as-is for premultiplied blending
  outColor = texture(u_texture, v_texCoord);
}
`

interface TextureInfo {
  texture: WebGLTexture
  width: number
  height: number
  /** Reference to the last uploaded source pixel data – used to skip redundant premultiplication + re-upload. */
  sourceData: Uint8ClampedArray | null
}

/** Cached result of the WebGL2 support check (null = not yet tested). */
let _webgl2Supported: boolean | null = null

/**
 * Check if WebGL2 is supported in the current browser.
 * Result is cached after the first call.
 */
export function isWebGL2Supported(): boolean {
  if (_webgl2Supported !== null) return _webgl2Supported
  if (typeof document === 'undefined') return (_webgl2Supported = false)
  try {
    const canvas = document.createElement('canvas')
    _webgl2Supported = !!canvas.getContext('webgl2')
  } catch {
    _webgl2Supported = false
  }
  return _webgl2Supported
}

/**
 * WebGL2-based subtitle renderer.
 * Uploads RGBA bitmap data to GPU textures and renders textured quads.
 * Uses premultiplied alpha blending to match WebGPU renderer output.
 */
export class WebGL2Renderer {
  private gl: WebGL2RenderingContext | null = null
  private program: WebGLProgram | null = null
  private vao: WebGLVertexArrayObject | null = null

  // Cached uniform locations
  private uResolution: WebGLUniformLocation | null = null
  private uDestRect: WebGLUniformLocation | null = null
  private uTexture: WebGLUniformLocation | null = null

  // Texture pool for compositions (indexed by slot)
  private textures: (TextureInfo | undefined)[] = []

  private _canvas: HTMLCanvasElement | null = null
  private _initialized = false
  private _width = 0
  private _height = 0

  /**
   * Initialize the WebGL2 renderer.
   * Kept async for API parity with WebGPURenderer, but WebGL2 init is synchronous.
   */
  async init(): Promise<void> {
    // No-op – actual init happens in setCanvas once we have a canvas element.
  }

  /**
   * Configure the canvas for WebGL2 rendering.
   */
  async setCanvas(canvas: HTMLCanvasElement, width: number, height: number): Promise<void> {
    this._canvas = canvas
    canvas.width = width
    canvas.height = height
    this._width = width
    this._height = height

    const gl = canvas.getContext('webgl2', {
      alpha: true,
      premultipliedAlpha: true,
      antialias: false,
      depth: false,
      stencil: false
    })

    if (!gl) {
      throw new Error('Could not get WebGL2 context')
    }

    this.gl = gl

    // Compile and link shader program
    const vertShader = this._compileShader(gl.VERTEX_SHADER, VERTEX_SHADER_SRC)
    const fragShader = this._compileShader(gl.FRAGMENT_SHADER, FRAGMENT_SHADER_SRC)

    const program = gl.createProgram()
    if (!program) throw new Error('Failed to create WebGL2 program')

    gl.attachShader(program, vertShader)
    gl.attachShader(program, fragShader)
    gl.linkProgram(program)

    gl.deleteShader(vertShader)
    gl.deleteShader(fragShader)

    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(program)
      gl.deleteProgram(program)
      throw new Error('WebGL2 program link failed: ' + log)
    }

    this.program = program
    gl.useProgram(program)

    // Cache uniform locations
    this.uResolution = gl.getUniformLocation(program, 'u_resolution')
    this.uDestRect = gl.getUniformLocation(program, 'u_destRect')
    this.uTexture = gl.getUniformLocation(program, 'u_texture')

    // VAO (required in WebGL2 even without vertex attributes)
    this.vao = gl.createVertexArray()
    gl.bindVertexArray(this.vao)

    // Set initial state
    gl.uniform2f(this.uResolution, width, height)
    gl.uniform1i(this.uTexture, 0)

    // Premultiplied alpha blending: src=ONE, dst=ONE_MINUS_SRC_ALPHA
    gl.enable(gl.BLEND)
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)

    gl.viewport(0, 0, width, height)

    this._initialized = true
    console.log('[libbitsub] WebGL2 renderer initialized')
  }

  private _compileShader(type: GLenum, src: string): WebGLShader {
    const gl = this.gl!
    const shader = gl.createShader(type)
    if (!shader) throw new Error('Failed to create shader')
    gl.shaderSource(shader, src)
    gl.compileShader(shader)
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(shader)
      gl.deleteShader(shader)
      throw new Error('Shader compile error: ' + log)
    }
    return shader
  }

  /**
   * Update canvas dimensions.
   */
  updateSize(width: number, height: number): void {
    if (!this.gl || !this._canvas) return

    this._canvas.width = width
    this._canvas.height = height
    this._width = width
    this._height = height

    this.gl.viewport(0, 0, width, height)
    this.gl.useProgram(this.program)
    this.gl.uniform2f(this.uResolution, width, height)
  }

  private _ensureTexture(index: number, width: number, height: number): TextureInfo {
    const gl = this.gl!
    const existing = this.textures[index]

    if (existing && existing.width === width && existing.height === height) {
      return existing
    }

    // Delete old texture if size changed
    if (existing) {
      gl.deleteTexture(existing.texture)
    }

    const texture = gl.createTexture()
    if (!texture) throw new Error('Failed to create WebGL2 texture')

    gl.bindTexture(gl.TEXTURE_2D, texture)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    // Allocate storage
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)

    const info: TextureInfo = { texture, width, height, sourceData: null }
    this.textures[index] = info
    return info
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
    if (!this.gl || !this.program || !this._canvas) return

    const gl = this.gl
    gl.useProgram(this.program)
    gl.bindVertexArray(this.vao)

    gl.clearColor(0, 0, 0, 0)
    gl.clear(gl.COLOR_BUFFER_BIT)

    gl.activeTexture(gl.TEXTURE0)

    for (let i = 0; i < compositions.length; i++) {
      const comp = compositions[i]
      const { pixelData, x, y } = comp
      const { width, height, data } = pixelData

      if (width <= 0 || height <= 0) continue

      const info = this._ensureTexture(i, width, height)
      gl.bindTexture(gl.TEXTURE_2D, info.texture)

      // Only premultiply and re-upload if the source ImageData buffer has changed
      if (info.sourceData !== data) {
        const uploadData = new Uint8Array(data.length)
        for (let j = 0; j < data.length; j += 4) {
          const a = data[j + 3]
          const af = a / 255
          uploadData[j] = (data[j] * af + 0.5) | 0
          uploadData[j + 1] = (data[j + 1] * af + 0.5) | 0
          uploadData[j + 2] = (data[j + 2] * af + 0.5) | 0
          uploadData[j + 3] = a
        }
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, uploadData)
        info.sourceData = data
      }

      // Calculate scaled position and size (mirrors WebGPU renderer maths)
      const scaledWidth = width * scaleX
      const scaledHeight = height * scaleY
      const baseX = x * (this._width / screenWidth)
      const baseY = y * (this._height / screenHeight)
      const centeredX = baseX + (width * (this._width / screenWidth) - scaledWidth) / 2
      const adjustedY = baseY + offsetY + (height * (this._height / screenHeight) - scaledHeight)

      gl.uniform4f(this.uDestRect, centeredX, adjustedY, scaledWidth, scaledHeight)

      // Draw 6 vertices for the two-triangle quad
      gl.drawArrays(gl.TRIANGLES, 0, 6)
    }

    // Free GPU textures in slots beyond the current composition count
    if (this.textures.length > compositions.length) {
      for (let i = compositions.length; i < this.textures.length; i++) {
        const stale = this.textures[i]
        if (stale) gl.deleteTexture(stale.texture)
      }
      this.textures.length = compositions.length
    }
  }

  /**
   * Clear the canvas.
   */
  clear(): void {
    if (!this.gl) return
    this.gl.clearColor(0, 0, 0, 0)
    this.gl.clear(this.gl.COLOR_BUFFER_BIT)
  }

  /**
   * Check if renderer is initialized.
   */
  get initialized(): boolean {
    return this._initialized
  }

  /**
   * Destroy all GPU resources.
   */
  destroy(): void {
    const gl = this.gl
    if (gl) {
      for (const info of this.textures) {
        if (info) gl.deleteTexture(info.texture)
      }
      if (this.program) gl.deleteProgram(this.program)
      if (this.vao) gl.deleteVertexArray(this.vao)
    }

    this.textures = []
    this.program = null
    this.vao = null
    this.gl = null
    this._canvas = null
    this._initialized = false
  }
}
