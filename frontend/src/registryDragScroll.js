export const REGISTRY_DRAG_THRESHOLD = 5

export function canStartRegistryDrag(button, isPrimary = true) {
  return button === 0 && isPrimary
}

export function hasRegistryDragStarted(startX, startY, currentX, currentY) {
  return Math.hypot(currentX - startX, currentY - startY) >= REGISTRY_DRAG_THRESHOLD
}

export function getRegistryDragScroll(startLeft, startTop, startX, startY, currentX, currentY) {
  return {
    left: startLeft - (currentX - startX),
    top: startTop - (currentY - startY),
  }
}
