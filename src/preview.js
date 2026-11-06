/* Gambar pratinjau slide dari hasil tata letak (sama dengan isi PPT). */
'use strict';

(function () {
  const PT_PER_IN = 72;

  function el(tag, cls) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    return e;
  }

  /**
   * @param slide satu slide dari deck:layout
   * @param size {w, h} dalam inci
   * @param widthPx lebar tampilan
   */
  function renderSlide(slide, size, widthPx) {
    const scale = widthPx / (size.w * PT_PER_IN); // px per poin
    const node = el('div', 'slide');
    node.style.height = `${(widthPx * size.h) / size.w}px`;
    node.style.backgroundColor = slide.background.color;
    if (slide.background.imageUrl) node.style.backgroundImage = `url("${slide.background.imageUrl}")`;
    for (const box of slide.boxes) {
      const b = el('div', 'box');
      b.style.left = `${(box.x / size.w) * 100}%`;
      b.style.top = `${(box.y / size.h) * 100}%`;
      b.style.width = `${(box.w / size.w) * 100}%`;
      b.style.height = `${(box.h / size.h) * 100}%`;
      b.style.fontFamily = `"${box.fontFace}", "Segoe UI", sans-serif`;
      b.style.fontSize = `${box.fontSize * scale}px`;
      b.style.color = box.color;
      b.style.fontWeight = box.bold ? '700' : '400';
      b.style.textAlign = box.align;
      b.style.justifyContent = box.valign === 'top' ? 'flex-start' : box.valign === 'bottom' ? 'flex-end' : 'center';
      b.style.padding = `${4 * scale}px`;
      for (const p of box.paragraphs) {
        const pe = el('p', p.bullet ? 'bullet' : '');
        if (p.align) pe.style.textAlign = p.align;
        for (const r of p.runs || []) {
          const s = el(r.superscript ? 'sup' : 'span');
          s.textContent = r.text;
          if (r.bold !== undefined) s.style.fontWeight = r.bold ? '700' : '400';
          if (r.color) s.style.color = r.color;
          if (r.italic) s.style.fontStyle = 'italic';
          pe.appendChild(s);
        }
        b.appendChild(pe);
      }
      node.appendChild(b);
    }
    return node;
  }

  window.WDPreview = { renderSlide };
})();
