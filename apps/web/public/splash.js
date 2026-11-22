      // Start animation: the logo draws itself, then the screen fades once the app has rendered. Short on purpose.
      ;(function () {
        var el = document.getElementById("splash"), t0 = Date.now(), gone = false
        var quiet = false
        try { quiet = matchMedia("(prefers-reduced-motion: reduce)").matches || !!(JSON.parse(localStorage.getItem("nevis.device") || "null") || {}).reduceMotion } catch (e) {}
        function remove() {
          if (el.parentNode) el.parentNode.removeChild(el)
          // the first-paint colours were only a stand-in: from here the stylesheet and the theme setting decide
          document.documentElement.style.removeProperty("background")
          document.documentElement.style.removeProperty("color-scheme")
        }
        window.__splashDone = function () {
          if (gone) return
          gone = true
          if (quiet) return remove()
          setTimeout(function () { el.className = "out"; setTimeout(remove, 550) }, Math.max(0, 2300 - (Date.now() - t0)))
        }
        if (quiet) el.style.display = "none"
        setTimeout(window.__splashDone, 8000)
      })()
