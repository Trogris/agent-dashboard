// ─────────────────────────────────────────────────────────────────────────────
//  Gerador de arquivos server-side para Telegram
//  Suporta: Excel (.xlsx), PowerPoint (.pptx), PDF (.pdf)
// ─────────────────────────────────────────────────────────────────────────────

const fs = require('fs');
const path = require('path');
const os = require('os');

// ── Extrai dados estruturados da resposta do agente ───────────────────────────
// O agente inclui um bloco entre ```file-data e ``` com JSON estruturado

function extractFileData(text) {
  const match = text.match(/```file-data\s*([\s\S]*?)```/i);
  if (!match) return null;
  try {
    return JSON.parse(match[1].trim());
  } catch {
    return null;
  }
}

// Remove o bloco file-data do texto visivel
function cleanText(text) {
  return text.replace(/```file-data[\s\S]*?```/gi, '').trim();
}

// ── Geradores ────────────────────────────────────────────────────────────────

async function generateExcel(data) {
  const XLSX = require('xlsx');
  const wb = XLSX.utils.book_new();

  const sheets = data.sheets || [{ name: 'Dados', rows: data.rows || [] }];

  for (const sheet of sheets) {
    const rows = sheet.rows || [];
    const ws = XLSX.utils.aoa_to_sheet(rows);

    if (rows.length > 0) {
      const colWidths = rows[0].map((_, i) =>
        Math.min(40, Math.max(10, ...rows.map(r => String(r[i] || '').length)))
      );
      ws['!cols'] = colWidths.map(w => ({ wch: w }));
    }

    XLSX.utils.book_append_sheet(wb, ws, sheet.name || 'Planilha');
  }

  const tmpPath = path.join(os.tmpdir(), `agent_${Date.now()}.xlsx`);
  XLSX.writeFile(wb, tmpPath);
  return tmpPath;
}

async function generatePptx(data) {
  const PptxGenJS = require('pptxgenjs');
  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_16x9';

  const title = data.title || 'Apresentação';
  const slides = data.slides || [];

  // Slide de capa
  const cover = pptx.addSlide();
  cover.background = { color: '1a1a2e' };
  cover.addText(title, {
    x: 0.5, y: 2.8, w: 9, h: 1.2,
    fontSize: 36, bold: true, color: 'FFFFFF', align: 'center'
  });
  if (data.subtitle) {
    cover.addText(data.subtitle, {
      x: 0.5, y: 4.1, w: 9, h: 0.6,
      fontSize: 16, color: 'AAAACC', align: 'center'
    });
  }
  cover.addText(new Date().toLocaleDateString('pt-BR'), {
    x: 0.5, y: 6.8, w: 9, h: 0.4,
    fontSize: 11, color: '888899', align: 'center'
  });

  for (const s of slides) {
    const slide = pptx.addSlide();
    slide.background = { color: 'FFFFFF' };

    slide.addText(s.title || '', {
      x: 0.4, y: 0.2, w: 9.2, h: 0.7,
      fontSize: 22, bold: true, color: '1a1a2e'
    });
    slide.addShape(pptx.ShapeType.rect, {
      x: 0.4, y: 0.95, w: 9.2, h: 0.04,
      fill: { color: '1a1a2e' }
    });

    if (s.table && s.table.length > 0) {
      const tableData = s.table.map((row, i) =>
        row.map(cell => ({
          text: String(cell),
          options: i === 0
            ? { bold: true, fill: '1a1a2e', color: 'FFFFFF', fontSize: 12 }
            : { fontSize: 12, fill: i % 2 === 0 ? 'F0F0F8' : 'FFFFFF' }
        }))
      );
      slide.addTable(tableData, {
        x: 0.4, y: 1.1, w: 9.2,
        fontSize: 12, border: { pt: 0.5, color: 'CCCCDD' }
      });
    } else if (s.bullets && s.bullets.length > 0) {
      const bulletText = s.bullets.map(b => ({ text: b, options: { bullet: true } }));
      slide.addText(bulletText, {
        x: 0.6, y: 1.1, w: 8.8, h: 5,
        fontSize: 14, color: '333333', valign: 'top', paraSpaceAfter: 8
      });
    } else if (s.text) {
      slide.addText(s.text, {
        x: 0.6, y: 1.1, w: 8.8, h: 5,
        fontSize: 14, color: '333333', valign: 'top'
      });
    }
  }

  const tmpPath = path.join(os.tmpdir(), `agent_${Date.now()}.pptx`);
  await pptx.writeFile({ fileName: tmpPath });
  return tmpPath;
}

async function generatePdf(data) {
  const PDFDocument = require('pdfkit');

  return new Promise((resolve, reject) => {
    const tmpPath = path.join(os.tmpdir(), `agent_${Date.now()}.pdf`);
    const doc = new PDFDocument({ margin: 50, size: 'A4', bufferPages: true });
    const stream = fs.createWriteStream(tmpPath);

    doc.pipe(stream);

    const title = data.title || 'Relatório';
    const sections = data.sections || [];

    // Cabecalho
    doc.rect(0, 0, doc.page.width, 80).fill('#1a1a2e');
    doc.fillColor('white').fontSize(22).font('Helvetica-Bold')
      .text(title, 50, 25, { width: doc.page.width - 100 });
    doc.fontSize(10).font('Helvetica').fillColor('#AAAACC')
      .text(new Date().toLocaleDateString('pt-BR'), 50, 55);

    doc.fillColor('#333333').moveDown(3);

    for (const section of sections) {
      if (doc.y > doc.page.height - 120) doc.addPage();

      if (section.title) {
        doc.fontSize(14).font('Helvetica-Bold').fillColor('#1a1a2e')
          .text(section.title);
        doc.moveTo(50, doc.y + 2).lineTo(545, doc.y + 2)
          .strokeColor('#1a1a2e').lineWidth(1).stroke();
        doc.moveDown(0.5);
      }

      if (section.text) {
        doc.fontSize(11).font('Helvetica').fillColor('#333333')
          .text(section.text, { lineGap: 4 });
        doc.moveDown(0.8);
      }

      if (section.bullets && section.bullets.length > 0) {
        for (const bullet of section.bullets) {
          doc.fontSize(11).font('Helvetica').fillColor('#333333')
            .text(`• ${bullet}`, { indent: 15, lineGap: 3 });
        }
        doc.moveDown(0.8);
      }

      if (section.table && section.table.length > 0) {
        const tableTop = doc.y;
        const colCount = section.table[0].length;
        const colWidth = 495 / colCount;

        section.table.forEach((row, rowIdx) => {
          if (doc.y > doc.page.height - 60) doc.addPage();
          const rowY = rowIdx === 0 ? tableTop : doc.y;

          if (rowIdx === 0) {
            doc.rect(50, rowY, 495, 22).fill('#1a1a2e');
          } else if (rowIdx % 2 === 0) {
            doc.rect(50, rowY, 495, 22).fill('#F0F0F8');
          }

          row.forEach((cell, colIdx) => {
            const color = rowIdx === 0 ? 'white' : '#333333';
            const font = rowIdx === 0 ? 'Helvetica-Bold' : 'Helvetica';
            doc.fontSize(10).font(font).fillColor(color)
              .text(String(cell), 55 + colIdx * colWidth, rowY + 6, {
                width: colWidth - 10, lineBreak: false
              });
          });

          doc.y = rowY + 22;
        });
        doc.moveDown(1);
      }
    }

    // Rodape com numero de pagina
    const range = doc.bufferedPageRange();
    for (let i = 0; i < range.count; i++) {
      doc.switchToPage(range.start + i);
      doc.fontSize(9).font('Helvetica').fillColor('#AAAAAA')
        .text(`Página ${i + 1} de ${range.count}`, 50, doc.page.height - 40, {
          align: 'center', width: doc.page.width - 100
        });
    }

    doc.end();
    stream.on('finish', () => resolve(tmpPath));
    stream.on('error', reject);
  });
}

// ── API publica ───────────────────────────────────────────────────────────────

async function generateFile(type, data) {
  switch (type) {
    case 'xlsx': return await generateExcel(data);
    case 'pptx': return await generatePptx(data);
    case 'pdf':  return await generatePdf(data);
    default: throw new Error(`Tipo de arquivo nao suportado: ${type}`);
  }
}

function deleteFile(filePath) {
  try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch {}
}

module.exports = { extractFileData, cleanText, generateFile, deleteFile };
