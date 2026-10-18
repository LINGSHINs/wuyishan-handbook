/*
 * glass-lens.js — 轻量WebGL液态玻璃(折射+色散+倒角高光)
 * shader核心移植自 JohnDeved/hic-liquid-glass (MIT)
 * 折射源: 主题SVG场景纹理 | canvas层pointer-events:none不拦截触摸
 */
(function(){
"use strict";
var FRAG="precision highp float;\n\nuniform sampler2D sceneTex;\nuniform vec2 resolution;       // viewport / FBO size in pixels (canvas backbuffer size, CSS px)\nuniform vec2 stageSize;        // sceneTex source size in CSS pixels (full stage)\nuniform vec2 canvasCenter;     // canvas center within the stage, CSS pixels (TL origin, y-down)\nuniform vec2 glassSize;        // glass plane size in pixels\nuniform vec2 thumbPos;         // glass center in world coords (updated per-frame)\nuniform float cornerRadius;    // corner radius in pixels\nuniform float bezelWidth;      // width of the curved bezel zone in pixels\nuniform float glassThickness;  // virtual glass thickness (refraction strength)\nuniform float ior;             // index of refraction (default 1.5)\nuniform float blurAmount;      // gaussian blur std-deviation in pixels\nuniform float specularOpacity; // strength of the specular highlight\nuniform float dispersion;      // edge chromatic + edge blur boost intensity (0..1)\nuniform int bezelType;         // 0 = lip, 1 = convex, 2 = concave, 3 = convexCircle\nuniform vec4 bgColor;          // pill's own bg color, composited OVER refraction (matches backdrop-filter)\n\nvarying vec2 vUv;\n\n/* \u2500\u2500 Bezel height functions (match @hashintel/refractive exactly) \u2500\u2500 */\n\nfloat convexCircleFn(float x) {\n  float t = 1.0 - x;\n  return sqrt(max(1.0 - t * t, 0.0));\n}\n\nfloat convexFn(float x) {\n  float t = 1.0 - x;\n  float t4 = t * t * t * t;\n  return pow(max(1.0 - t4, 0.0), 0.25);\n}\n\nfloat concaveFn(float x) {\n  return 1.0 - convexCircleFn(x);\n}\n\nfloat lipFn(float x) {\n  float a = convexFn(x * 2.0);\n  float b = concaveFn(x) + 0.1;\n  // smoothstep polynomial: 6x^5 - 15x^4 + 10x^3\n  float t = x * x * x * (x * (x * 6.0 - 15.0) + 10.0);\n  return mix(a, b, t);\n}\n\nfloat bezelHeight(float x) {\n  float cx = clamp(x, 0.0, 1.0);\n  if (bezelType == 0) return lipFn(cx);\n  if (bezelType == 1) return convexFn(cx);\n  if (bezelType == 2) return concaveFn(cx);\n  return convexCircleFn(cx);\n}\n\n/* \u2500\u2500 Snell's law refraction (exact port of refractive library) \u2500\u2500 */\n// Returns pixel displacement for a given surface normal.\n// Incident ray = (0, -1) looking straight down onto the surface.\n// Normal = (-dh/ds, -1) / length \u2014 as in the refractive library.\n\nfloat snellDisplacement(float normalX, float normalY, float height, float bw, float thickness, float refIdx) {\n  float sinRatio = 1.0 / refIdx;\n  float cosI = normalY;\n  float sin2T = sinRatio * sinRatio * (1.0 - cosI * cosI);\n  float cos2T = 1.0 - sin2T;\n  if (cos2T < 0.0) return 0.0; // total internal reflection\n  float cosT = sqrt(cos2T);\n  float refractedX = -(sinRatio * cosI + cosT) * normalX;\n  float refractedY = sinRatio - (sinRatio * cosI + cosT) * normalY;\n  if (abs(refractedY) < 0.0001) return 0.0;\n  float totalHeight = height * bw + thickness;\n  return refractedX * (totalHeight / refractedY);\n}\n\n/* \u2500\u2500 Rounded rect SDF \u2500\u2500 */\n\nfloat roundedBoxSDF(vec2 p, vec2 b, float r) {\n  vec2 d = abs(p) - b + r;\n  return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0) - r;\n}\n\n/* \u2500\u2500 Specular highlight (matches refractive's specular map) \u2500\u2500 */\n// Thin ring near border (~2px wide), modulated by angle with specular direction.\n// Library uses specularAngle = PI/4 (upper-right light source).\n\nconst float SPECULAR_EDGE = 20.0;\nconst vec2 SPECULAR_DIR = vec2(0.7071, 0.7071); // cos(PI/4), sin(PI/4)\n\nfloat computeSpecular(float distToBorder, vec2 borderDir) {\n  if (distToBorder >= SPECULAR_EDGE) return 0.0;\n  // Library direction: (dx/dist, -dy/dist) in screen coords \u2014 flip y for GL\n  vec2 dir = vec2(borderDir.x, -borderDir.y);\n  float dl = length(dir);\n  if (dl < 0.001) return 0.0;\n  dir /= dl;\n  float angleDot = abs(dot(dir, SPECULAR_DIR));\n  // Circular fade: peaks at 1px from border, zero at border and ~2px inside\n  float inner = 1.0 - (1.0 - distToBorder) * (1.0 - distToBorder);\n  float fade = inner > 0.0 ? sqrt(inner) : 0.0;\n  return angleDot * fade;\n}\n\nvoid main() {\n  // Local position in pixels relative to glass center\n  vec2 localPx = (vUv - 0.5) * glassSize;\n\n  // Rounded rect SDF\n  vec2 halfSize = glassSize * 0.5;\n  float r = min(cornerRadius, min(halfSize.x, halfSize.y));\n  float dist = roundedBoxSDF(localPx, halfSize, r);\n\n  // Discard outside rounded rect (with 1px AA band)\n  if (dist > 1.0) discard;\n  float edgeAlpha = 1.0 - smoothstep(-0.5, 0.5, dist);\n\n  // Distance to border (positive inside)\n  float distToBorder = max(0.0, -dist);\n\n  // sceneTex sampling is in stage coords (canvas may be smaller than stage now)\n  vec2 mp = thumbPos + localPx;\n  vec2 sceneUV = vec2(\n    (canvasCenter.x + mp.x) / stageSize.x,\n    (stageSize.y - canvasCenter.y + mp.y) / stageSize.y\n  );\n\n  // Compute displacement in the bezel zone\n  vec2 displacement = vec2(0.0);\n  float specularValue = 0.0;\n  float edgeFactor = 0.0; // 0 in flat center, 1 at the bezel rim\n\n  float bw = min(bezelWidth, min(halfSize.x, halfSize.y));\n\n  if (distToBorder < bw && bw > 0.5) {\n    float normalizedDist = distToBorder / bw; // 0 at border \u2192 1 inside\n    edgeFactor = 1.0 - normalizedDist;\n\n    // Bezel height and derivative\n    float h = bezelHeight(normalizedDist);\n    float eps = 0.001;\n    float h2 = bezelHeight(normalizedDist + eps);\n    float dh = (h2 - h) / eps;\n\n    // Surface normal (matching refractive: (-dh/ds, -1) / length)\n    float nLen = sqrt(dh * dh + 1.0);\n    float nx = -dh / nLen;\n    float ny = -1.0 / nLen;\n\n    // Snell's law displacement (in pixels)\n    float pixelDisp = snellDisplacement(nx, ny, h, bw, glassThickness, ior);\n\n    // Direction: SDF gradient points outward (toward nearest border)\n    float sdxR = roundedBoxSDF(localPx + vec2(0.5, 0.0), halfSize, r);\n    float sdxL = roundedBoxSDF(localPx - vec2(0.5, 0.0), halfSize, r);\n    float sdyR = roundedBoxSDF(localPx + vec2(0.0, 0.5), halfSize, r);\n    float sdyL = roundedBoxSDF(localPx - vec2(0.0, 0.5), halfSize, r);\n    vec2 borderDir = vec2(sdxR - sdxL, sdyR - sdyL);\n    float bdLen = length(borderDir);\n    if (bdLen > 0.001) borderDir /= bdLen;\n\n    // Apply displacement in radial direction (inward, matching refractive's -cos/-sin).\n    // Scale by 127/255 to match SVG feDisplacementMap 8-bit channel encoding\n    // (channel range 0.5\u00b10.498, so effective displacement is ~49.8% of raw value).\n    displacement = -borderDir * pixelDisp * (127.0 / 255.0);\n\n    // Smooth fade at the very edge for anti-aliasing\n    float edgeFade = smoothstep(0.0, 2.0, distToBorder);\n    displacement *= edgeFade;\n\n    // Specular (thin ring at border, independent of displacement edgeFade)\n    specularValue = computeSpecular(distToBorder, borderDir);\n  }\n\n  // Sample scene texture with displacement\n  vec2 displacedUV = sceneUV + displacement / stageSize;\n  displacedUV = clamp(displacedUV, vec2(0.001), vec2(0.999));\n\n  // Chromatic aberration: split R/B sampling along the displacement vector,\n  // strongest at the bezel rim, zero in the flat center. Scaled by dispersion.\n  vec2 aberrOffset = (displacement / stageSize) * (0.35 * dispersion * edgeFactor);\n\n  // Edge-amplified blur: ADDS its own sigma budget at the rim (driven by\n  // dispersion alone) on top of the user-set base blur. Center stays sharp;\n  // the rim softens like the smeared fall-off in Apple's Liquid Glass.\n  float effSigma = blurAmount + dispersion * edgeFactor * edgeFactor * 10.0;\n\n  // Gaussian blur (only when effective sigma > threshold)\n  vec4 sceneColor;\n  if (effSigma > 0.5) {\n    sceneColor = vec4(0.0);\n    float total = 0.0;\n    float sigma = effSigma;\n    int rad = int(min(ceil(sigma * 2.5), 12.0));\n    for (int y = -12; y <= 12; y++) {\n      for (int x = -12; x <= 12; x++) {\n        int ax = x < 0 ? -x : x;\n        int ay = y < 0 ? -y : y;\n        if (ax > rad || ay > rad) continue;\n        float w = exp(-float(x * x + y * y) / (2.0 * sigma * sigma));\n        vec2 off = vec2(float(x), float(y)) / stageSize;\n        float r = texture2D(sceneTex, displacedUV + off + aberrOffset).r;\n        float g = texture2D(sceneTex, displacedUV + off).g;\n        float b = texture2D(sceneTex, displacedUV + off - aberrOffset).b;\n        float a = texture2D(sceneTex, displacedUV + off).a;\n        sceneColor += vec4(r, g, b, a) * w;\n        total += w;\n      }\n    }\n    sceneColor /= total;\n  } else {\n    float r = texture2D(sceneTex, displacedUV + aberrOffset).r;\n    float g = texture2D(sceneTex, displacedUV).g;\n    float b = texture2D(sceneTex, displacedUV - aberrOffset).b;\n    float a = texture2D(sceneTex, displacedUV).a;\n    sceneColor = vec4(r, g, b, a);\n  }\n\n  // Composite the pill's own bg-color OVER the refracted scene. This mirrors\n  // how CSS \\`backdrop-filter\\` works: refract what's behind, then paint the\n  // element's own background on top. The placeholder DOM is invisible (opacity:0)\n  // so it doesn't contaminate the HIC capture \u2014 bgColor here IS its bg.\n  sceneColor.rgb = mix(sceneColor.rgb, bgColor.rgb, bgColor.a);\n\n  // Apple-style outer rim highlight: a single continuous bright band hugging\n  // the perimeter. Uses specularOpacity to stay user-controllable.\n  vec3 rimTint = vec3(0.88, 0.97, 1.0); // slight cool/cyan cast\n  float outerRim = exp(-pow((distToBorder - 1.2) / 1.4, 2.0));\n  float rimAlpha = outerRim * 0.6 * specularOpacity;\n  sceneColor.rgb = mix(sceneColor.rgb, rimTint, rimAlpha);\n\n  // Add specular highlight (white overlay)\n  float specAlpha = specularValue * specularOpacity;\n  sceneColor.rgb = mix(sceneColor.rgb, vec3(1.0), specAlpha);\n\n  vec3 finalColor = sceneColor.rgb;\n\n  gl_FragColor = vec4(finalColor, edgeAlpha);\n}\n";
var VERT="attribute vec2 a_position;attribute vec2 a_uv;varying vec2 vUv;void main(){vUv=a_uv;gl_Position=vec4(a_position,0.0,1.0);}";

function Lens(canvas, opts){
  this.canvas=canvas; this.o=opts||{};
  this.gl=canvas.getContext('webgl',{alpha:true,antialias:true,premultipliedAlpha:false});
  if(!this.gl) return;
  var gl=this.gl;
  // quad
  var buf=gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER,buf);
  gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,0,0, 1,-1,1,0, -1,1,0,1,  1,-1,1,0, 1,1,1,1, -1,1,0,1]),gl.STATIC_DRAW);
  var self2=this;
  function sh(type,src){
    var s=gl.createShader(type);gl.shaderSource(s,src);gl.compileShader(s);
    if(!gl.getShaderParameter(s,gl.COMPILE_STATUS)){self2.err=(self2.err||'')+'\n'+gl.getShaderInfoLog(s);return null;}
    return s;
  }
  var vs=sh(gl.VERTEX_SHADER,VERT), fs=sh(gl.FRAGMENT_SHADER,FRAG);
  if(!vs||!fs){this.dead=true;return;}
  var pr=gl.createProgram();
  gl.attachShader(pr,vs);gl.attachShader(pr,fs);gl.linkProgram(pr);
  if(!gl.getProgramParameter(pr,gl.LINK_STATUS)){this.err=(this.err||'')+'LINK:'+gl.getProgramInfoLog(pr);this.dead=true;return;}
  gl.useProgram(pr);
  var lp=gl.getAttribLocation(pr,'a_position'),lu=gl.getAttribLocation(pr,'a_uv');
  gl.enableVertexAttribArray(lp);gl.vertexAttribPointer(lp,2,gl.FLOAT,false,16,0);
  gl.enableVertexAttribArray(lu);gl.vertexAttribPointer(lu,2,gl.FLOAT,false,16,8);
  this.u={};
  var self=this;
  ['resolution','stageSize','canvasCenter','glassSize','thumbPos','cornerRadius','bezelWidth','glassThickness','ior','blurAmount','specularOpacity','dispersion','bezelType','bgColor','sceneTex','scrollY'].forEach(function(n){
    self.u[n]=gl.getUniformLocation(pr,n);
  });
  this.prog=pr;
  // texture
  this.tex=gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D,this.tex);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
  this.img=null; this.imgSize=[400,800];
  this.scrollY=0;
  var self=this;
  (function loop(){ if(self.dead)return; self.render(); self._raf=requestAnimationFrame(loop); })();
}
Lens.prototype.setScene=function(img,w,h){
  this.img=img;this.imgSize=[w,h];
  var gl=this.gl;
  // 先光栅化到离屏canvas(SVG直接上纹理尺寸不稳)
  var oc=document.createElement('canvas');oc.width=w*2;oc.height=h*2;
  var octx=oc.getContext('2d');
  octx.filter='contrast(1.7) saturate(1.35)';octx.drawImage(img,0,0,oc.width,oc.height);octx.filter='none';
  gl.bindTexture(gl.TEXTURE_2D,this.tex);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL,false);
  try{gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,oc);}catch(e){this.err='tex:'+e.message;}
};
Lens.prototype.render=function(){
  if(this.dead)return;
  var gl=this.gl,c=this.canvas,o=this.o;
  var dpr=Math.min(window.devicePixelRatio||1,2);
  var w=c.clientWidth,h=c.clientHeight;
  if(!w||!h)return;
  if(c.width!==w*dpr||c.height!==h*dpr){c.width=w*dpr;c.height=h*dpr;}
  gl.viewport(0,0,c.width,c.height);
  gl.useProgram(this.prog);
  var r=c.getBoundingClientRect();
  gl.uniform2f(this.u.resolution,c.width,c.height);
  gl.uniform2f(this.u.stageSize,this.imgSize[0],this.imgSize[1]);
  // canvas中心映射到场景纹理坐标(场景图为cover铺满视口)
  var vw=window.innerWidth,vh=window.innerHeight;
  var cx=(r.left+r.width/2)/vw*400, cy=(r.top+r.height/2)/vh*800 - this.scrollY*0.0;
  gl.uniform2f(this.u.canvasCenter,cx,cy);
  gl.uniform2f(this.u.glassSize,w,h);
  gl.uniform2f(this.u.thumbPos,w/2,h/2);
  gl.uniform1f(this.u.cornerRadius,o.radius||32);
  gl.uniform1f(this.u.bezelWidth,o.bezel!=null?o.bezel:14);
  gl.uniform1f(this.u.glassThickness,o.thickness!=null?o.thickness:22);
  gl.uniform1f(this.u.ior,o.ior||1.45);
  gl.uniform1f(this.u.blurAmount,o.blur!=null?o.blur:2.0);
  gl.uniform1f(this.u.specularOpacity,o.specular!=null?o.specular:0.45);
  gl.uniform1f(this.u.dispersion,o.dispersion!=null?o.dispersion:0.5);
  gl.uniform1i(this.u.bezelType,o.bezelType||1);
  var bg=o.bg||[1,1,1,0.14];
  gl.uniform4f(this.u.bgColor,bg[0],bg[1],bg[2],bg[3]);
  gl.uniform1f(this.u.scrollY,window.scrollY||0);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D,this.tex);
  gl.uniform1i(this.u.sceneTex,0);
  gl.clearColor(0,0,0,0);
  gl.clear(gl.COLOR_BUFFER_BIT);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA,gl.ONE_MINUS_SRC_ALPHA);
  gl.drawArrays(gl.TRIANGLES,0,6);
};
window.GlassLens=Lens;
})();
