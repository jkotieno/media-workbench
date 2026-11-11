import type { TransformDocument } from "@/shared/types";

type TransformAdjustments = TransformDocument["edit"]["adjustments"];

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

uniform sampler2D u_texture;
uniform float u_brightness;
uniform float u_contrast;
uniform float u_saturation;
uniform float u_hue_radians;
varying vec2 v_texture_coordinate;

void main() {
  vec4 sampled = texture2D(u_texture, v_texture_coordinate);
  vec3 color = sampled.rgb;
  color *= u_brightness;
  color = (color - 0.5 * sampled.a) * u_contrast + 0.5 * sampled.a;

  float luminance = dot(color, vec3(0.213, 0.715, 0.072));
  color = mix(vec3(luminance), color, u_saturation);

  float hue_cos = cos(u_hue_radians);
  float hue_sin = sin(u_hue_radians);
  color = vec3(
    (0.213 + hue_cos * 0.787 - hue_sin * 0.213) * color.r +
      (0.715 - hue_cos * 0.715 - hue_sin * 0.715) * color.g +
      (0.072 - hue_cos * 0.072 + hue_sin * 0.928) * color.b,
    (0.213 - hue_cos * 0.213 + hue_sin * 0.143) * color.r +
      (0.715 + hue_cos * 0.285 + hue_sin * 0.140) * color.g +
      (0.072 - hue_cos * 0.072 - hue_sin * 0.283) * color.b,
    (0.213 - hue_cos * 0.213 - hue_sin * 0.787) * color.r +
      (0.715 - hue_cos * 0.715 + hue_sin * 0.715) * color.g +
      (0.072 + hue_cos * 0.928 + hue_sin * 0.072) * color.b
  );

  gl_FragColor = vec4(clamp(color, 0.0, sampled.a), sampled.a);
}
`;

function compileShader(
  gl: WebGLRenderingContext,
  type: number,
  source: string,
): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) {
    throw new Error("Unable to allocate Transform preview shader");
  }
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const message = gl.getShaderInfoLog(shader) || "Unknown shader compile failure";
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
    throw new Error("Unable to allocate Transform preview program");
  }
  gl.attachShader(program, vertexShader);
  gl.attachShader(program, fragmentShader);
  gl.linkProgram(program);
  gl.deleteShader(vertexShader);
  gl.deleteShader(fragmentShader);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const message = gl.getProgramInfoLog(program) || "Unknown shader link failure";
    gl.deleteProgram(program);
    throw new Error(message);
  }
  return program;
}

function getPreviewContext(canvas: HTMLCanvasElement): WebGLRenderingContext {
  const gl = canvas.getContext("webgl", {
    alpha: true,
    antialias: false,
    depth: false,
    preserveDrawingBuffer: false,
    premultipliedAlpha: true,
    stencil: false,
  });
  if (!gl) {
    throw new Error("WebGL is unavailable for the Transform preview");
  }
  return gl;
}

export class TransformPreviewRenderer {
  private canvas: HTMLCanvasElement;
  private gl: WebGLRenderingContext;
  private program: WebGLProgram;
  private texture: WebGLTexture;
  private brightnessLocation: WebGLUniformLocation | null;
  private contrastLocation: WebGLUniformLocation | null;
  private saturationLocation: WebGLUniformLocation | null;
  private hueLocation: WebGLUniformLocation | null;
  private textureWidth = 0;
  private textureHeight = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const resources = this.createResources(canvas);
    this.gl = resources.gl;
    this.program = resources.program;
    this.texture = resources.texture;
    this.brightnessLocation = resources.brightnessLocation;
    this.contrastLocation = resources.contrastLocation;
    this.saturationLocation = resources.saturationLocation;
    this.hueLocation = resources.hueLocation;
  }

  private createResources(canvas: HTMLCanvasElement) {
    const gl = getPreviewContext(canvas);
    const program = createProgram(gl);
    gl.useProgram(program);

    const buffer = gl.createBuffer();
    if (!buffer) {
      throw new Error("Unable to allocate Transform preview geometry");
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 3, -1, -1, 3]),
      gl.STATIC_DRAW,
    );
    const positionLocation = gl.getAttribLocation(program, "a_position");
    gl.enableVertexAttribArray(positionLocation);
    gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 0, 0);

    const texture = gl.createTexture();
    if (!texture) {
      throw new Error("Unable to allocate Transform preview texture");
    }
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 1);
    gl.uniform1i(gl.getUniformLocation(program, "u_texture"), 0);

    return {
      gl,
      program,
      texture,
      brightnessLocation: gl.getUniformLocation(program, "u_brightness"),
      contrastLocation: gl.getUniformLocation(program, "u_contrast"),
      saturationLocation: gl.getUniformLocation(program, "u_saturation"),
      hueLocation: gl.getUniformLocation(program, "u_hue_radians"),
    };
  }

  private ensureMountedCanvas(): void {
    if (this.canvas.isConnected) {
      return;
    }
    const replacement = this.canvas.ownerDocument.querySelector<HTMLCanvasElement>(
      '[data-testid="transform-edit-surface"] > canvas',
    );
    if (!replacement || replacement === this.canvas) {
      return;
    }

    const resources = this.createResources(replacement);
    this.canvas = replacement;
    this.gl = resources.gl;
    this.program = resources.program;
    this.texture = resources.texture;
    this.brightnessLocation = resources.brightnessLocation;
    this.contrastLocation = resources.contrastLocation;
    this.saturationLocation = resources.saturationLocation;
    this.hueLocation = resources.hueLocation;
    this.textureWidth = 0;
    this.textureHeight = 0;
  }

  resize(width: number, height: number): void {
    this.ensureMountedCanvas();
    this.gl.viewport(0, 0, width, height);
  }

  uploadFull(source: HTMLCanvasElement): void {
    this.ensureMountedCanvas();
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0);
    if (
      this.textureWidth === source.width &&
      this.textureHeight === source.height
    ) {
      gl.texSubImage2D(
        gl.TEXTURE_2D,
        0,
        0,
        0,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        source,
      );
    } else {
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        source,
      );
      this.textureWidth = source.width;
      this.textureHeight = source.height;
    }
  }

  uploadRegion(
    bytes: Uint8ClampedArray<ArrayBufferLike>,
    x: number,
    y: number,
    width: number,
    height: number,
  ): void {
    this.ensureMountedCanvas();
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texSubImage2D(
      gl.TEXTURE_2D,
      0,
      x,
      y,
      width,
      height,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      bytes,
    );
  }

  draw(adjustments: TransformAdjustments): void {
    this.ensureMountedCanvas();
    const gl = this.gl;
    gl.useProgram(this.program);
    gl.uniform1f(this.brightnessLocation, adjustments.brightness);
    gl.uniform1f(this.contrastLocation, adjustments.contrast);
    gl.uniform1f(this.saturationLocation, adjustments.saturation);
    gl.uniform1f(this.hueLocation, adjustments.hueDegrees * Math.PI / 180);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
}

export function createTransformPreviewRenderer(
  canvas: HTMLCanvasElement,
): TransformPreviewRenderer | null {
  try {
    return new TransformPreviewRenderer(canvas);
  } catch (error) {
    console.warn("Transform WebGL preview unavailable", error);
    return null;
  }
}
