const { NVIDIA_API_KEY, GEMINI_API_KEY } = process.env;

async function testNvidia() {
  const model = "qwen/qwen3.5-122b-a10b";
  console.log(`Testing NVIDIA model: ${model}...`);
  try {
    const response = await fetch("https://integrate.api.nvidia.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${NVIDIA_API_KEY}`
      },
      body: JSON.stringify({
        model: model,
        messages: [{ role: "user", content: "Hello" }],
        max_tokens: 10
      })
    });
    console.log(`Status: ${response.status}`);
    const data = await response.json();
    if (!response.ok) {
      console.log("Error:", JSON.stringify(data, null, 2));
    } else {
      console.log("NVIDIA Success!");
    }
  } catch (e) {
    console.log("NVIDIA Request Failed:", e.message);
  }
}

async function testGemini() {
  const model = "gemini-2.5-flash";
  console.log(`\nTesting Gemini model: ${model}...`);
  try {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: "Hello" }] }]
      })
    });
    console.log(`Status: ${response.status}`);
    const data = await response.json();
    if (!response.ok) {
      console.log("Error:", JSON.stringify(data, null, 2));
    } else {
      console.log("Gemini Success!");
    }
  } catch (e) {
    console.log("Gemini Request Failed:", e.message);
  }
}

testNvidia().then(testGemini);
