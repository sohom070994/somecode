// The portal lands here after a successful booking.
chrome.runtime.sendMessage({ type: 'BOOKED', url: location.href }).catch(() => {});
