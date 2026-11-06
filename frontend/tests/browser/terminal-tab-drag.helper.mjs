// Real mouse input: exercise PointerEvent capture and the post-drag click.
export function terminalTabDrag({ send, evaluate, waitFor }) {
  async function move(point) {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point, button: 'left', buttons: 1 })
  }
  async function begin(id) {
    const point = await evaluate(`(() => {
      const button = document.getElementById('terminal-tab-' + ${JSON.stringify(id)});
      button.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
      const r = button.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`)
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point })
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 })
    await move({ x: point.x + 8, y: point.y })
    await waitFor(`document.querySelector('.is-drag-source')?.dataset.terminalId === ${JSON.stringify(id)}`)
    return point
  }
  async function end(point) {
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 })
    await waitFor(`!document.querySelector('.session-tab-strip.is-dragging, .drop-before, .drop-after')`)
  }
  async function toward(id, side) {
    const point = await evaluate(`(() => {
      const r = document.getElementById('terminal-tab-' + ${JSON.stringify(id)}).closest('.tab').getBoundingClientRect();
      return { x: r.left + r.width * ${side === 'before' ? 0.2 : 0.8}, y: r.top + r.height / 2 };
    })()`)
    await move(point)
    await waitFor(`document.querySelector('.drop-${side}')?.dataset.terminalId === ${JSON.stringify(id)}`)
    return point
  }
  async function reorder(id, targetId, side) {
    await begin(id)
    await end(await toward(targetId, side))
  }
  return { begin, move, end, toward, reorder }
}
