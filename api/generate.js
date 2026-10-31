module.exports = async (req, res) => {
  // Izinkan akses dari browser (CORS) dan tes koneksi
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Gunakan metode POST" });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: "GEMINI_API_KEY belum diatur di Vercel" });
  }

  const b = req.body || {};
  const subject = b.subject || "";
  const grade = b.grade || "";
  const material = b.material || "";
  const count = Math.min(Number(b.count) || 10, 50);
  const types = Array.isArray(b.types) && b.types.length ? b.types : ["Pilihan ganda"];
  const levels = Array.isArray(b.levels) && b.levels.length ? b.levels : ["C1", "C2"];
  const assessment = b.assessment || "";
  const notes = b.notes || "";

  if (!subject || !material) {
    return res.status(400).json({ error: "Mata pelajaran dan materi wajib diisi" });
  }

  const prompt = `Kamu adalah guru SD berpengalaman di Indonesia yang ahli menyusun soal sesuai Kurikulum Merdeka.
Buatkan TEPAT ${count} soal dengan ketentuan berikut:
- Mata pelajaran: ${subject}
- Kelas: ${grade} SD
- Jenis asesmen: ${assessment}
- Materi / CP / TP: ${material}
- Bentuk soal yang dipakai (bagi rata): ${types.join(", ")}
- Level kognitif yang dipakai (bagi rata): ${levels.join(", ")}
- Ketentuan tambahan: ${notes || "tidak ada"}

Aturan:
1. Bahasa Indonesia yang sesuai usia siswa kelas ${grade}. Gunakan konteks kehidupan sehari-hari.
2. Isi field "type" persis salah satu dari: ${types.join(" | ")}.
3. Isi field "level" persis salah satu dari: ${levels.join(" | ")}.
4. Pilihan ganda: "options" berisi 4 teks pilihan TANPA awalan huruf (A., B., dst), "answer" berupa satu huruf (A/B/C/D).
5. Pilihan ganda kompleks: "options" 4-5 teks, "answer" berisi huruf-huruf benar, contoh "A dan C".
6. Benar atau salah: "options" berisi ["Benar","Salah"], "answer" berisi "Benar" atau "Salah".
7. Menjodohkan: tulis pasangan di dalam teks "question", "options" kosong, "answer" berisi pasangan yang benar.
8. Isian singkat dan Uraian: "options" array kosong, "answer" berisi jawaban/pedoman penilaian.
9. "explanation" berisi pembahasan singkat, "indicator" berisi indikator soal, "topic" berisi subtopik materi.
10. Soal harus akurat secara fakta dan kunci jawabannya benar.`;

  const schema = {
    type: "OBJECT",
    properties: {
      questions: {
        type: "ARRAY",
        items: {
          type: "OBJECT",
          properties: {
            type: { type: "STRING" },
            level: { type: "STRING" },
            topic: { type: "STRING" },
            question: { type: "STRING" },
            options: { type: "ARRAY", items: { type: "STRING" } },
            answer: { type: "STRING" },
            explanation: { type: "STRING" },
            indicator: { type: "STRING" },
          },
          required: ["type", "level", "question", "options", "answer"],
        },
      },
    },
    required: ["questions"],
  };

  try {
    const response = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": apiKey,
        },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            responseMimeType: "application/json",
            responseSchema: schema,
          },
        }),
      }
    );

    const data = await response.json();
    if (!response.ok) {
      return res.status(502).json({
        error:
          "Gemini membalas " + response.status + ": " +
          ((data.error && data.error.message) || "Gagal memanggil Gemini"),
      });
    }

    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      return res.status(502).json({ error: "Balasan AI tidak bisa dibaca, coba lagi" });
    }

    if (!parsed.questions || !parsed.questions.length) {
      return res.status(502).json({ error: "AI tidak menghasilkan soal, coba lagi" });
    }
    return res.status(200).json({ questions: parsed.questions });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
