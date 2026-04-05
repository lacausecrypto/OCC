/** Draw type-specific vector icon on canvas (no emoji). */
export function drawNodeIcon(
  ctx: CanvasRenderingContext2D,
  type: string,
  cx: number,
  cy: number,
  color: string,
): void {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = 1.5;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  switch (type) {
    case "agent": // person silhouette
      ctx.beginPath();
      ctx.arc(0, -3, 3.5, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(-5, 8);
      ctx.quadraticCurveTo(-5, 1, 0, 1);
      ctx.quadraticCurveTo(5, 1, 5, 8);
      ctx.stroke();
      break;
    case "router": // fork arrows
      ctx.beginPath();
      ctx.moveTo(-5, 0);
      ctx.lineTo(0, 0);
      ctx.lineTo(5, -5);
      ctx.moveTo(0, 0);
      ctx.lineTo(5, 5);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(3, -7);
      ctx.lineTo(5, -5);
      ctx.lineTo(3, -3);
      ctx.moveTo(3, 3);
      ctx.lineTo(5, 5);
      ctx.lineTo(3, 7);
      ctx.stroke();
      break;
    case "evaluator": // bar chart
      ctx.fillRect(-5, 2, 3, 6);
      ctx.fillRect(-1, -2, 3, 10);
      ctx.fillRect(3, -5, 3, 13);
      break;
    case "gate": // shield
      ctx.beginPath();
      ctx.moveTo(0, -7);
      ctx.lineTo(6, -4);
      ctx.lineTo(6, 2);
      ctx.quadraticCurveTo(6, 7, 0, 9);
      ctx.quadraticCurveTo(-6, 7, -6, 2);
      ctx.lineTo(-6, -4);
      ctx.closePath();
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(0, -2);
      ctx.lineTo(0, 4);
      ctx.moveTo(-3, 1);
      ctx.lineTo(3, 1);
      ctx.stroke();
      break;
    case "transform": // gear
      ctx.beginPath();
      for (let i = 0; i < 6; i++) {
        const a = (i * Math.PI) / 3 - Math.PI / 2;
        ctx.lineTo(Math.cos(a) * 7, Math.sin(a) * 7);
        ctx.lineTo(Math.cos(a + 0.3) * 4.5, Math.sin(a + 0.3) * 4.5);
      }
      ctx.closePath();
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(0, 0, 2, 0, Math.PI * 2);
      ctx.stroke();
      break;
    case "loop": // circular arrows
      ctx.beginPath();
      ctx.arc(0, 0, 6, -0.5, Math.PI * 1.5);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(4, -5);
      ctx.lineTo(6, -2);
      ctx.lineTo(2, -2);
      ctx.fill();
      break;
    case "merge": // converging arrows
      ctx.beginPath();
      ctx.moveTo(-6, -5);
      ctx.lineTo(0, 0);
      ctx.lineTo(-6, 5);
      ctx.moveTo(0, 0);
      ctx.lineTo(6, 0);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(4, -2);
      ctx.lineTo(6, 0);
      ctx.lineTo(4, 2);
      ctx.fill();
      break;
    case "webhook": // signal/antenna
      ctx.beginPath();
      ctx.moveTo(0, 3);
      ctx.lineTo(0, -3);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(0, -3, 3, Math.PI * 1.2, Math.PI * 1.8);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(0, -3, 6, Math.PI * 1.25, Math.PI * 1.75);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(0, 3, 1.5, 0, Math.PI * 2);
      ctx.fill();
      break;
    case "subchain": // nested boxes
      ctx.strokeRect(-6, -5, 9, 7);
      ctx.strokeRect(-3, -2, 9, 7);
      break;
    case "debate": // scales
      ctx.beginPath();
      ctx.moveTo(0, -7);
      ctx.lineTo(0, 5);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(-7, -3);
      ctx.lineTo(7, -3);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(-7, -3);
      ctx.lineTo(-5, 3);
      ctx.lineTo(-9, 3);
      ctx.closePath();
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(7, -3);
      ctx.lineTo(9, 1);
      ctx.lineTo(5, 1);
      ctx.closePath();
      ctx.stroke();
      break;
    case "browser": // globe
      ctx.beginPath();
      ctx.arc(0, 0, 6, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.ellipse(0, 0, 3, 6, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(-6, 0);
      ctx.lineTo(6, 0);
      ctx.stroke();
      break;
    default: // dot
      ctx.beginPath();
      ctx.arc(0, 0, 4, 0, Math.PI * 2);
      ctx.fill();
  }
  ctx.restore();
}
