// Saving never touches pdf.js (it only renders on screen), and it can't load outside a browser
// or Vite, so tests swap it and its worker URL for empty stand-ins.
import { register } from 'node:module';
register('data:text/javascript,' + encodeURIComponent(`
export async function resolve(spec, ctx, next) {
  if (spec === 'pdfjs-dist') return { url: 'data:text/javascript,export const GlobalWorkerOptions = {};', shortCircuit: true };
  if (spec.endsWith('?url')) return { url: 'data:text/javascript,export default "";', shortCircuit: true };
  return next(spec, ctx);
}`));
