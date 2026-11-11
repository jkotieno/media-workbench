import type { RasterBounds } from "@/features/transform/rasterEngine";
import type { TransformMaskViewMode } from "@/shared/types";

const VERTEX_SHADER_SOURCE = `
attribute vec2 a_position;
varying vec2 v_texture_coordinate;

void main() {
  gl_Position = vec4(a_position, 0.0, 1.0);
  v_texture_coordinate = vec2(
    (a_position.x + 1.0) * 0.5,
    (1.0 - a_position.y) * 0.5
  );
}
`;

const FRAGMENT_SHADER_SOURCE = `
precision mediump float;

uniform sampler2D u_coverage;
uniform float u_view_mode;
uniform vec3 u_overlay_color;
uniform float u_overlay_opacity;
varying vec2 v_texture_coordinate;

void main() {
  float coverage = texture2D(u_coverage, v_texture_coordinate).r;
  if (u_view_mode < 0.5) {
    gl_FragColor = vec4(0.0);
  } else if (u_view_mode < 1.5) {
    gl_FragColor = vec4(vec3(coverage), 1.0);
  } else {
    float alpha = coverage * u_overlay_opacity;
    gl_FragColor = vec4(u_overlay_color * alpha, alpha);
  }
}
`;

function compileShader(
  gl: WebGLRenderingContext,
  type: number,
  source: string,
): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) {
    throw new Error("Unable to allocate mask preview shader");
  }
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const message = gl.getShaderInfoLog(shader) || "Unknown mask shader compile failure";
    gl.deleteShader(shader);
    throw new Error(message);
  }
  return shader;
}

function createProgram(gl: WebGLRenderingContext): WebGLProgram {
  const vertexShader = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER_SOURCE);
  const fragmentShader = compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER_SOURCE);
  const program = gl.createProgram();
  if (!program) {
    throw new Error("Unable to allocate mask preview program");
  }
  gl.attachShader(program, vertexShader);
  gl.attachShader(program, fragmentShader);
  gl.linkProgram(program);
  gl.deleteShader(vertexShader);
  gl.deleteShader(fragmentShader);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const message = gl.getProgramInfoLog(program) || "Unknown mask shader link failure";
    gl.deleteProgram(program);
    throw new Error(message);
  }
  return program;
}

function parseHexColor(value: string): [number, number, number] {
  const normalized = /^#[0-9a-f]{6}$/i.test(value) ? value : "#16b8d4";
  return [
    Number.parseInt(normalized.slice(1, 3), 16) / 255,
    Number.parseInt(normalized.slice(3, 5), 16) / 255,
    Number.parseInt(normalized.slice(5, 7), 16) / 255,
  ];
}

export class MaskPreviewRenderer {
  private readonly gl: WebGLRenderingContext;
  private readonly program: WebGLProgram;
  private readonly texture: WebGLTexture;
  private readonly viewModeLocation: WebGLUniformLocation | null;
  private readonly overlayColorLocation: WebGLUniformLocation | null;
  private readonly overlayOpacityLocation: WebGLUniformLocation | null;
  private textureWidth = 0;
  private textureHeight = 0;

  constructor(canvas: HTMLCanvasElement) {
    const gl = canvas.getContext("webgl", {
      alpha: true,
      antialias: false,
      depth: false,
      preserveDrawingBuffer: false,
      premultipliedAlpha: true,
      stencil: false,
    });
    if (!gl) {
      throw new Error("WebGL is unavailable for the mask preview");
    }
    this.gl = gl;
    this.program = createProgram(gl);
    gl.useProgram(this.program);

    const buffer = gl.createBuffer();
    if (!buffer) {
      throw new Error("Unable to allocate mask preview geometry");
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 3, -1, -1, 3]),
      gl.STATIC_DRAW,
    );
    const positionLocation = gl.getAttribLocation(this.program, "a_position");
    gl.enableVertexAttribArray(positionLocation);
    gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 0, 0);

    const texture = gl.createTexture();
    if (!texture) {
      throw new Error("Unable to allocate mask coverage texture");
    }
    this.texture = texture;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.uniform1i(gl.getUniformLocation(this.program, "u_coverage"), 0);

    this.viewModeLocation = gl.getUniformLocation(this.program, "u_view_mode");
    this.overlayColorLocation = gl.getUniformLocation(this.program, "u_overlay_color");
    this.overlayOpacityLocation = gl.getUniformLocation(this.program, "u_overlay_opacity");
  }

  resize(width: number, height: number): void {
    this.gl.viewport(0, 0, width, height);
  }

  uploadFull(
    coverage: Uint8ClampedArray<ArrayBufferLike>,
    width: number,
    height: number,
  ): void {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.LUMINANCE,
      width,
      height,
      0,
      gl.LUMINANCE,
      gl.UNSIGNED_BYTE,
      coverage,
    );
    this.textureWidth = width;
    this.textureHeight = height;
  }

  uploadRegion(
    coverage: Uint8ClampedArray<ArrayBufferLike>,
    sourceWidth: number,
    bounds: RasterBounds,
  ): void {
    if (!this.textureWidth || !this.textureHeight) {
      return;
    }
    const packed = new Uint8Array(bounds.width * bounds.height);
    for (let row = 0; row < bounds.height; row += 1) {
      packed.set(
        coverage.subarray(
          (bounds.y + row) * sourceWidth + bounds.x,
          (bounds.y + row) * sourceWidth + bounds.x + bounds.width,
        ),
        row * bounds.width,
      );
    }
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texSubImage2D(
      gl.TEXTURE_2D,
      0,
      bounds.x,
      bounds.y,
      bounds.width,
      bounds.height,
      gl.LUMINANCE,
      gl.UNSIGNED_BYTE,
      packed,
    );
  }

  draw(
    viewMode: TransformMaskViewMode,
    overlayColor: string,
    overlayOpacity: number,
  ): void {
    const gl = this.gl;
    const color = parseHexColor(overlayColor);
    gl.useProgram(this.program);
    gl.uniform1f(
      this.viewModeLocation,
      viewMode === "image" ? 0 : viewMode === "mask" ? 1 : 2,
    );
    gl.uniform3f(this.overlayColorLocation, color[0], color[1], color[2]);
    gl.uniform1f(this.overlayOpacityLocation, overlayOpacity);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
}

export function createMaskPreviewRenderer(
  canvas: HTMLCanvasElement,
): MaskPreviewRenderer | null {
  try {
    return new MaskPreviewRenderer(canvas);
  } catch (error) {
    console.warn("Mask WebGL preview unavailable", error);
    return null;
  }
}
