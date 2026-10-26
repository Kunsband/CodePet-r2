const test = require("node:test");
const assert = require("node:assert/strict");
const { ChatRoom } = require("../src/chat/chat-room");

function makeAgents() {
  return [
    { id: "claude", name: "Claude", aliases: ["claude"], available: true, enabled: true },
    { id: "codex", name: "Codex", aliases: ["codex"], available: true, enabled: true },
    {
      id: "agy",
      name: "Antigravity",
      aliases: ["agy", "antigravity"],
      available: false,
      enabled: true,
      reason: "agy CLI가 설치되어 있지 않습니다.",
    },
  ];
}

// 즉시 응답하는 페이크 러너: replies[에이전트 id] 배열을 순서대로 소비합니다.
function fakeRunner(replies, calls = []) {
  return ({ agent, prompt, attachments }) => {
    calls.push({ agentId: agent.id, prompt, attachments });
    const queue = replies[agent.id] || [];
    const next = queue.length > 0 ? queue.shift() : { ok: true, text: "…" };
    return { promise: Promise.resolve(next), cancel: () => {} };
  };
}

async function settle(room) {
  await room.waitForIdle();
  await new Promise((resolve) => setImmediate(resolve));
}

test("custom mentions route handoffs by stable ID even if a participant is renamed during a run", async () => {
  const agents = makeAgents().map((agent, index) => ({ ...agent, name: index === 0 ? "검토 담당" : "작업 담당",
    mention: index === 0 ? "검토" : "작업", aliases: [index === 0 ? "검토" : "작업", ...agent.aliases] }));
  let finish;
  const calls = [];
  const room = new ChatRoom({ agents, runAgent: ({ agent, prompt }) => {
    calls.push({ id: agent.id, prompt });
    return { promise: agent.id === "codex" ? new Promise((resolve) => { finish = resolve; })
      : Promise.resolve({ ok: true, text: "검토 완료" }), cancel() {} };
  } });
  room.sendUserMessage("@작업 확인해");
  assert.deepEqual(calls.map((call) => call.id), ["codex"]);
  assert.match(calls[0].prompt, /참가자 "@작업"\(작업 담당\)/);
  assert.match(calls[0].prompt, /@검토\(검토 담당\)/);
  assert.match(calls[0].prompt, /@검토=claude/);
  room.setAgents(agents.map((agent) => agent.id === "claude"
    ? { ...agent, name: "새 검토 담당", mention: "리뷰", aliases: ["리뷰", "claude"] } : agent));
  finish({ ok: true, text: "@검토 검토해줘" });
  await settle(room);
  assert.deepEqual(calls.map((call) => call.id), ["codex", "claude"]);
  assert.match(calls[1].prompt, /참가자 "@리뷰"\(새 검토 담당\)/);
  assert.match(calls[1].prompt, /\[@작업\] @검토 검토해줘/);
  assert.equal(room.messages.at(-1).author, "claude");
  assert.equal(room.messages.at(-1).agentMeta.mention, "리뷰");
  assert.equal(room.publicAgents()[0].mention, "리뷰");
});

test("동시 수신한 답변은 완료 순서대로 표시하고 토론은 모두 완료된 뒤 시작한다", async () => {
  const releases = new Map();
  const calls = [];
  const room = new ChatRoom({ agents: makeAgents(), runAgent: ({ agent, prompt }) => {
    calls.push(agent.id);
    if (prompt.includes("자율 토론")) return { promise: Promise.resolve({ ok: true, text: "결론 [[CODEPET_DISCUSSION:CONCLUDE]]" }), cancel() {} };
    return { promise: new Promise((resolve) => releases.set(agent.id, resolve)), cancel() {} };
  } });
  room.sendUserMessage("@모두 작업해");
  assert.equal(releases.size, 2);
  const discussion = room.startDiscussion();
  releases.get("codex")({ ok: true, text: "빠른 완료" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(room.messages.at(-1).author, "codex");
  assert.equal(calls.length, 2);
  releases.get("claude")({ ok: true, text: "늦은 완료" });
  await discussion;
  await settle(room);
  assert.deepEqual(room.messages.filter((entry) => entry.authorType === "agent").slice(0, 2).map((entry) => entry.text), ["빠른 완료", "늦은 완료"]);
});

test("회사 모드는 캐릭터 말투와 이모티콘을 요청하거나 저장하지 않는다", async () => {
  const calls = [];
  const room = new ChatRoom({ agents: makeAgents(), meta: { workMode: true },
    runAgent: fakeRunner({ codex: [{ ok: true, text: "검토 완료 [[CODEPET_EMOTE:검토완료]]" }] }, calls) });
  room.sendUserMessage("@codex 확인해");
  await settle(room);
  assert.doesNotMatch(calls[0].prompt, /CODEPET_EMOTE|티격태격|가벼운 도발/);
  assert.equal(room.messages.at(-1).emoticons, undefined);
  assert.equal(room.messages.at(-1).contentParts, undefined);
  assert.equal(room.messages.at(-1).text, "검토 완료");
});

test("멘션된 에이전트만 응답한다", async () => {
  const calls = [];
  const room = new ChatRoom({
    agents: makeAgents(),
    runAgent: fakeRunner({ codex: [{ ok: true, text: "네!" }] }, calls),
  });
  room.sendUserMessage("@codex 응답해라");
  await settle(room);

  assert.deepEqual(calls.map((call) => call.agentId), ["codex"]);
  const agentMessages = room.messages.filter((message) => message.authorType === "agent");
  assert.equal(agentMessages.length, 1);
  assert.equal(agentMessages[0].author, "codex");
  assert.equal(agentMessages[0].text, "네!");
});

test("에이전트 이모티콘 표기는 첫 번째 한 개만 본문과 분리해 저장한다", async () => {
  const room = new ChatRoom({
    agents: makeAgents(),
    runAgent: fakeRunner({
      codex: [{
        ok: true,
        text: "검토 끝났습니다.\n[[CODEPET_EMOTE:검토완료]]\n[[CODEPET_EMOTE:좋은데]]",
      }],
    }),
  });
  room.sendUserMessage("@codex 검토해줘");
  await settle(room);

  const response = room.messages.find((message) => message.author === "codex");
  assert.equal(response.text, "검토 끝났습니다.");
  assert.deepEqual(response.emoticons, [
    { key: "검토완료", file: "검토완료.png", folder: "gpt" },
  ]);
  assert.deepEqual(response.contentParts.map((part) => part.type), [
    "text",
    "emoticon",
  ]);
});

test("에이전트 실행 전 준비 단계를 기다리고 실제 오류를 대화에 남긴다", async () => {
  const calls = [];
  const room = new ChatRoom({
    agents: makeAgents(),
    prepareAgent: async ({ agent }) => {
      calls.push(`prepare:${agent.id}`);
      throw new Error("Codex 로컬 프록시 복구 실패: 포트 연결 거부");
    },
    runAgent: () => {
      calls.push("run");
      return { promise: Promise.resolve({ ok: true, text: "실행되면 안 됨" }), cancel: () => {} };
    },
  });
  room.sendUserMessage("@codex 검토해");
  await settle(room);

  assert.deepEqual(calls, ["prepare:codex"]);
  const error = room.messages.find((message) => message.author === "codex" && message.error);
  assert.match(error.text, /프록시 복구 실패: 포트 연결 거부/);
});

test("멘션이 없으면 세션에 참여 중인 모든 에이전트가 응답한다", async () => {
  const calls = [];
  const room = new ChatRoom({ agents: makeAgents(), runAgent: fakeRunner({}, calls) });
  room.sendUserMessage("둘 다 의견 줘");
  await settle(room);
  assert.deepEqual(calls.map((call) => call.agentId).sort(), ["claude", "codex"]);
});

test("여러 수신자는 같은 메시지를 동시에 받고 서로의 미완료 답변을 문맥에 넣지 않는다", async () => {
  const calls = [];
  const room = new ChatRoom({
    agents: makeAgents(),
    random: () => 0.99, // Fisher-Yates에서 스왑 없음 → [claude, codex] 순서 고정
    runAgent: fakeRunner(
      {
        claude: [{ ok: true, text: "첫 번째 의견이야" }],
        codex: [{ ok: true, text: "이어서 보완할게요" }],
      },
      calls
    ),
  });
  room.sendUserMessage("둘 다 의견 줘");
  await settle(room);

  assert.deepEqual(calls.map((call) => call.agentId), ["claude", "codex"]);
  for (const call of calls) {
    assert.match(call.prompt, /동시에 받았습니다/);
    assert.doesNotMatch(call.prompt, /첫 번째 의견이야|2번째입니다/);
  }
});

test("브로드캐스트 응답 순서는 주입한 난수원에 따라 섞인다", async () => {
  const calls = [];
  const room = new ChatRoom({
    agents: makeAgents(),
    random: () => 0, // Fisher-Yates에서 항상 스왑 → [codex, claude] 순서
    runAgent: fakeRunner({}, calls),
  });
  room.sendUserMessage("둘 다 의견 줘");
  await settle(room);

  assert.deepEqual(calls.map((call) => call.agentId), ["codex", "claude"]);
});

test("같은 메시지의 수신자는 앞 응답을 기다리지 않고 실행한다", async () => {
  let active = 0;
  let maxActive = 0;
  const calls = [];
  const room = new ChatRoom({
    agents: makeAgents(),
    random: () => 0.99,
    runAgent: ({ agent }) => {
      calls.push(agent.id);
      active += 1;
      maxActive = Math.max(maxActive, active);
      return {
        promise: new Promise((resolve) => setImmediate(() => {
          active -= 1;
          resolve({ ok: true, text: `${agent.id} 답변` });
        })),
        cancel: () => {},
      };
    },
  });
  room.sendUserMessage("모두 한 턴씩 말해");
  await settle(room);

  assert.deepEqual(calls, ["claude", "codex"]);
  assert.equal(maxActive, 2);
});

test("동시 수신 이후의 멘션은 새 요청을 읽는 후속 응답으로 이어진다", async () => {
  const calls = [];
  const room = new ChatRoom({
    agents: makeAgents(),
    random: () => 0.99,
    runAgent: fakeRunner({
      claude: [{ ok: true, text: "@codex 이어서 말해줘" }],
      codex: [{ ok: true, text: "한 번만 답할게요" }],
    }, calls),
  });
  room.sendUserMessage("둘 다 의견 줘");
  await settle(room);

  assert.deepEqual(calls.map((call) => call.agentId), ["claude", "codex", "codex"]);
  assert.match(calls[2].prompt, /@codex 이어서 말해줘/);
});

test("동시 실행 중인 수신자의 후속 호출은 기존 응답 뒤에 실행한다", async () => {
  const agents = makeAgents();
  agents[2].available = true;
  const calls = [];
  const room = new ChatRoom({
    agents,
    random: () => 0.99,
    runAgent: fakeRunner({
      claude: [{ ok: true, text: "@agy 다음으로 답해줘" }],
      codex: [{ ok: true, text: "Codex 답" }],
      agy: [{ ok: true, text: "AGY 답" }],
    }, calls),
  });
  room.sendUserMessage("셋 다 의견 줘");
  await settle(room);

  assert.deepEqual(calls.map((call) => call.agentId), ["claude", "codex", "agy", "agy"]);
  assert.ok(calls.slice(0, 3).every((call) => /동시에 받았습니다/.test(call.prompt)));
  assert.doesNotMatch(calls[3].prompt, /동시에 받았습니다/);
  assert.match(calls[3].prompt, /@agy 다음으로 답해줘/);
});

test("단독 응답의 여러 멘션은 문장 순서대로 함께 시작한다", async () => {
  const agents = makeAgents();
  agents[2].available = true;
  const calls = [];
  const room = new ChatRoom({
    agents,
    random: () => 0.99,
    runAgent: fakeRunner({
      claude: [{ ok: true, text: "@agy 먼저, @codex 다음으로 답해줘" }],
      codex: [{ ok: true, text: "Codex 답" }],
      agy: [{ ok: true, text: "AGY 답" }],
    }, calls),
  });
  room.sendUserMessage("@claude 의견 줘");
  await settle(room);

  assert.deepEqual(calls.map((call) => call.agentId), ["claude", "agy", "codex"]);
});

test("전달받은 작업을 다른 참가자에게 다시 전달할 수 있다", async () => {
  const agents = makeAgents();
  agents[2].available = true;
  const calls = [];
  const room = new ChatRoom({
    agents,
    random: () => 0.99,
    runAgent: fakeRunner({
      claude: [{ ok: true, text: "@agy 다음으로 답해줘" }],
      codex: [{ ok: true, text: "Codex 답" }],
      agy: [{ ok: true, text: "@codex 다시 답해줘" }],
    }, calls),
  });
  room.sendUserMessage("@claude 의견 줘");
  await settle(room);

  assert.deepEqual(calls.map((call) => call.agentId), ["claude", "agy", "codex"]);
  assert.ok(calls.slice(0, 2).every((call) => !/추가 호출할 수 없습니다/.test(call.prompt)));
  // 사용자 메시지 기준 2단계에서 호출된 참가자는 더 호출할 수 없다고 안내받습니다.
  assert.match(calls[2].prompt, /추가 호출할 수 없습니다/);
});

test("턴 상태 이벤트는 동시에 작업 중인 모든 참가자를 공개한다", async () => {
  const agents = makeAgents();
  agents[2].available = true;
  const states = [];
  const room = new ChatRoom({
    agents,
    random: () => 0.99,
    runAgent: fakeRunner({
      claude: [{ ok: true, text: "@agy 먼저, @codex 다음으로 답해줘" }],
      codex: [{ ok: true, text: "Codex 답" }],
      agy: [{ ok: true, text: "AGY 답" }],
    }),
  });
  room.on("turn-state", (state) => states.push(state));
  room.sendUserMessage("셋 다 의견 줘");
  await settle(room);

  assert.ok(states.some((state) =>
    state.current === "claude"
    && state.currentAgents.join(",") === "claude,codex,agy"
    && state.queue.length === 0
  ));
});

test("새 사용자 멘션은 진행 중인 동시 작업 뒤에 실행한다", async () => {
  const agents = makeAgents();
  agents[2].available = true;
  const calls = [];
  const states = [];
  let releaseFirst;
  const room = new ChatRoom({
    agents,
    random: () => 0.34, // [agy, claude, codex] 순서로 고정
    runAgent: ({ agent }) => {
      calls.push(agent.id);
      if (calls.length === 1) {
        return {
          promise: new Promise((resolve) => { releaseFirst = resolve; }),
          cancel: () => {},
        };
      }
      return { promise: Promise.resolve({ ok: true, text: `${agent.id} 답` }), cancel: () => {} };
    },
  });
  room.on("turn-state", (state) => states.push(state));

  room.sendUserMessage("셋 다 의견 줘");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ["agy", "claude", "codex"]);

  room.sendUserMessage("@agy 네 말투를 소개해줘");
  assert.ok(states.some((state) =>
    state.current === "agy"
    && state.queue.map((turn) => turn.agentId).join(",") === "agy"
  ));

  releaseFirst({ ok: true, text: "AGY 첫 답" });
  await settle(room);

  assert.deepEqual(calls, ["agy", "claude", "codex", "agy"]);
});

test("사용자 다중 멘션은 문장에 나온 순서를 보존한다", async () => {
  const agents = makeAgents();
  agents[2].available = true;
  const calls = [];
  let releaseFirst;
  const room = new ChatRoom({
    agents,
    random: () => 0, // 기존 셔플이라면 [codex, agy]로 뒤집힘
    runAgent: ({ agent }) => {
      calls.push(agent.id);
      if (calls.length === 1) {
        return {
          promise: new Promise((resolve) => { releaseFirst = resolve; }),
          cancel: () => {},
        };
      }
      return { promise: Promise.resolve({ ok: true, text: `${agent.id} 답` }), cancel: () => {} };
    },
  });

  room.sendUserMessage("@claude 먼저 기다려줘");
  await new Promise((resolve) => setImmediate(resolve));
  room.sendUserMessage("@agy 먼저, @codex 다음으로 답해줘");
  releaseFirst({ ok: true, text: "Claude 답" });
  await settle(room);

  assert.deepEqual(calls, ["claude", "agy", "codex"]);
});

test("서로 다른 사용자 메시지의 같은 에이전트 턴은 합치지 않는다", async () => {
  const calls = [];
  let releaseFirst;
  const room = new ChatRoom({
    agents: makeAgents(),
    runAgent: ({ agent }) => {
      calls.push(agent.id);
      if (calls.length === 1) {
        return {
          promise: new Promise((resolve) => { releaseFirst = resolve; }),
          cancel: () => {},
        };
      }
      return { promise: Promise.resolve({ ok: true, text: "두 번째 답" }), cancel: () => {} };
    },
  });
  room.sendUserMessage("@codex 첫 질문");
  room.sendUserMessage("@codex 둘째 질문");
  releaseFirst({ ok: true, text: "첫 번째 답" });
  await settle(room);

  assert.deepEqual(calls, ["codex", "codex"]);
});

test("한 답변에서 여러 명을 호출하면 앞 참가자의 완료를 기다리지 않는다", async () => {
  const agents = makeAgents();
  agents[2].available = true;
  const calls = [];
  let active = 0;
  let maxActive = 0;
  const replies = {
    claude: [{ ok: true, text: "@codex 먼저, @agy도 다음에 답해줘" }],
    codex: [{ ok: true, text: "Codex 답" }],
    agy: [{ ok: true, text: "AGY 답" }],
  };
  const room = new ChatRoom({
    agents,
    runAgent: ({ agent }) => {
      calls.push(agent.id);
      active += 1;
      maxActive = Math.max(maxActive, active);
      const result = replies[agent.id].shift();
      return {
        promise: new Promise((resolve) => setImmediate(() => {
          active -= 1;
          resolve(result);
        })),
        cancel: () => {},
      };
    },
  });
  room.sendUserMessage("@claude 의견을 이어가줘");
  await settle(room);

  assert.deepEqual(calls, ["claude", "codex", "agy"]);
  assert.equal(maxActive, 2);
});

test("설치되지 않은 에이전트를 부르면 이유가 담긴 시스템 안내를 남긴다", async () => {
  const calls = [];
  const room = new ChatRoom({ agents: makeAgents(), runAgent: fakeRunner({}, calls) });
  room.sendUserMessage("@agy 있니?");
  await settle(room);

  assert.equal(calls.length, 0);
  const systemMessages = room.messages.filter((message) => message.authorType === "system");
  assert.equal(systemMessages.length, 1);
  assert.match(systemMessages[0].text, /설치되어 있지 않습니다/);
});

test("세션에서 비활성화된 에이전트는 멘션해도 실행되지 않는다", async () => {
  const agents = makeAgents();
  agents[1].enabled = false;
  const calls = [];
  const room = new ChatRoom({ agents, runAgent: fakeRunner({}, calls) });
  room.sendUserMessage("@codex 응답해라");
  await settle(room);

  assert.equal(calls.length, 0);
  const systemMessages = room.messages.filter((message) => message.authorType === "system");
  assert.match(systemMessages[0].text, /비활성화/);
});

test("에이전트가 @이름으로 부르면 그 에이전트가 이어서 응답한다", async () => {
  const calls = [];
  const room = new ChatRoom({
    agents: makeAgents(),
    runAgent: fakeRunner(
      {
        claude: [{ ok: true, text: "@codex 네 생각은? Antigravity 얘기도 참고해." }],
        codex: [{ ok: true, text: "불려서 답합니다." }],
      },
      calls
    ),
  });
  room.sendUserMessage("@claude 의견 줘");
  await settle(room);

  // @codex는 실제 호출, @ 없는 "Antigravity"는 언급이라 실행되지 않는다.
  assert.deepEqual(calls.map((call) => call.agentId), ["claude", "codex"]);
  const agentMessages = room.messages.filter((message) => message.authorType === "agent");
  assert.equal(agentMessages.length, 2);
  assert.equal(agentMessages[1].author, "codex");
});

test("작업 전달과 결과 보고는 사용자 메시지 기준 2단계까지 이어지고 자기 호출은 무시된다", async () => {
  const calls = [];
  const room = new ChatRoom({
    agents: makeAgents(),
    runAgent: fakeRunner(
      {
        claude: [
          { ok: true, text: "@claude 나 말고 @codex 어때?" },
          { ok: true, text: "@codex 다시 부른다!" },
        ],
        codex: [{ ok: true, text: "@claude 되물을게요." }],
      },
      calls
    ),
  });
  room.sendUserMessage("@claude 시작해");
  await settle(room);

  assert.deepEqual(calls.map((call) => call.agentId), ["claude", "codex", "claude"]);
  assert.match(calls[1].prompt, /그러면 그 참가자가 이어서 답합니다/);
  assert.match(calls[2].prompt, /추가 호출할 수 없습니다/);
});

test("코드·이메일·그룹 별칭은 에이전트 답변에서 추가 호출을 만들지 않는다", async () => {
  const calls = [];
  const room = new ChatRoom({
    agents: makeAgents(),
    runAgent: fakeRunner({
      claude: [{ ok: true, text: "`@codex` contact@codex.dev @모두" }],
    }, calls),
  });
  room.sendUserMessage("@claude 시작해");
  await settle(room);
  assert.deepEqual(calls.map((call) => call.agentId), ["claude"]);
});

test("답변의 코드 안에 백틱 문자열이 있어도 예시 멘션으로 다른 에이전트를 호출하지 않는다", async () => {
  const calls = [];
  const room = new ChatRoom({
    agents: makeAgents(),
    runAgent: fakeRunner({
      claude: [{ ok: true, text: '```js\nconst delimiter = "```";\n@codex\n```' }],
    }, calls),
  });
  room.sendUserMessage("@claude 예시를 보여줘");
  await settle(room);
  assert.deepEqual(calls.map((call) => call.agentId), ["claude"]);
});

test("줄 중간 백틱과 공백이 붙은 닫는 펜스 뒤의 실제 멘션은 전달한다", async () => {
  for (const text of ["예시 ```x``` 뒤 @codex", "```js\nx\n```\u00a0\n@codex"]) {
    const calls = [];
    const room = new ChatRoom({
      agents: makeAgents(),
      runAgent: fakeRunner({ claude: [{ ok: true, text }] }, calls),
    });
    room.sendUserMessage("@claude 검토해줘");
    await settle(room);
    assert.deepEqual(calls.map((call) => call.agentId), ["claude", "codex"], text);
  }
});

test("연쇄 깊이 상한을 늘리면 한 작업의 20회 왕복에서도 호출과 첨부가 유지된다", async () => {
  const calls = [];
  const attachment = { id: "review", name: "task.txt", kind: "text" };
  const room = new ChatRoom({ agents: makeAgents(), mentionChainLimit: 20, runAgent: ({ agent, prompt, attachments }) => {
    calls.push({ agentId: agent.id, prompt, attachments });
    const next = agent.id === "claude" ? "codex" : "claude";
    return { promise: Promise.resolve({ ok: true, text: calls.length < 20
      ? `@${next} 검토와 결과 보고를 이어가줘` : "작업 완료" }), cancel() {} };
  } });
  room.sendUserMessage({ text: "@claude 작업해줘", attachments: [attachment] });
  await settle(room);
  assert.equal(calls.length, 20);
  assert.ok(calls.every((call, index) => call.agentId === (index % 2 ? "codex" : "claude")));
  assert.ok(calls.every((call) => !/추가 호출할 수 없습니다/.test(call.prompt)));
  assert.ok(calls.every((call) => call.attachments[0] === attachment));
  assert.equal(room.messages.at(-1).text, "작업 완료");
});

test("길게 이어지는 멘션도 사용자 개입 시 즉시 취소하고 다음 호출을 막는다", async () => {
  const calls = [];
  let cancelled = false;
  const room = new ChatRoom({ agents: makeAgents(), mentionChainLimit: 100, runAgent: ({ agent }) => {
    calls.push(agent.id);
    const next = agent.id === "claude" ? "codex" : "claude";
    if (calls.length === 12) {
      let finish;
      return { promise: new Promise((resolve) => {
        finish = resolve;
        setImmediate(() => room.interject());
      }), cancel: () => { cancelled = true; finish({ ok: true, text: `@${next} 늦은 호출` }); } };
    }
    return { promise: Promise.resolve({ ok: true, text: `@${next} 이어가줘` }), cancel() {} };
  } });
  room.sendUserMessage("@claude 시작해");
  await settle(room);
  assert.equal(calls.length, 12);
  assert.equal(cancelled, true);
  assert.equal(room.turnQueue.length, 0);
  assert.ok(room.messages.every((message) => !message.text.includes("늦은 호출")));
});

test("작업 중인 같은 수신자의 후속 호출은 그 수신자의 완료를 기다린다", async () => {
  const calls = [];
  let finishCodex;
  const room = new ChatRoom({ agents: makeAgents(), random: () => 0.99, runAgent: ({ agent, prompt }) => {
    calls.push({ agentId: agent.id, prompt });
    if (calls.length === 1) return { promise: Promise.resolve({ ok: true, text: "@codex 결과를 검토해줘" }), cancel() {} };
    if (calls.length === 2) return { promise: new Promise((resolve) => { finishCodex = resolve; }), cancel() {} };
    return { promise: Promise.resolve({ ok: true, text: "검토 완료" }), cancel() {} };
  } });
  room.sendUserMessage("@모두 작업해");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 2);
  assert.equal(room.turnQueue.length, 1);
  finishCodex({ ok: true, text: "초기 작업 완료" });
  await settle(room);
  assert.deepEqual(calls.map((call) => call.agentId), ["claude", "codex", "codex"]);
  assert.match(calls[2].prompt, /@codex 결과를 검토해줘/);
  assert.match(calls[2].prompt, /초기 작업 완료/);
});

test("토론 답변의 @멘션은 자체 턴 외 추가 호출을 만들지 않는다", async () => {
  const calls = [];
  const room = new ChatRoom({
    agents: makeAgents(),
    runAgent: fakeRunner({
      claude: [{ ok: true, text: "@codex 확인해줘\n[[CODEPET_DISCUSSION:CONCLUDE]]" }],
    }, calls),
  });
  await room.startDiscussion();
  await settle(room);
  assert.deepEqual(calls.map((call) => call.agentId), ["claude"]);
  assert.match(calls[0].prompt, /추가 호출할 수 없습니다/);
});

test("멘션 연쇄 응답에도 원래 첨부를 전달한다", async () => {
  const calls = [];
  const attachment = { id: "a", name: "review.txt", kind: "text" };
  const room = new ChatRoom({
    agents: makeAgents(),
    runAgent: fakeRunner({
      claude: [{ ok: true, text: "@codex도 파일을 확인해줘" }],
      codex: [{ ok: true, text: "확인했어요" }],
    }, calls),
  });
  room.sendUserMessage({ text: "@claude 검토해", attachments: [attachment] });
  await settle(room);
  assert.deepEqual(calls.map((call) => call.attachments), [[attachment], [attachment]]);
});

test("멘션 호출도 비활성·미설치 에이전트는 건너뛴다", async () => {
  const calls = [];
  const room = new ChatRoom({
    agents: makeAgents(),
    runAgent: fakeRunner(
      { claude: [{ ok: true, text: "@agy 있어?" }] },
      calls
    ),
  });
  room.sendUserMessage("@claude 시작해");
  await settle(room);

  // agy는 available:false라 멘션 호출로도 실행되지 않는다.
  assert.deepEqual(calls.map((call) => call.agentId), ["claude"]);
});

test("자율 토론은 차례로 말하고 결론 신호에서 즉시 끝난다", async () => {
  const calls = [];
  const room = new ChatRoom({
    agents: makeAgents(),
    runAgent: fakeRunner({
      claude: [{ ok: true, text: "첫 의견\n[[CODEPET_DISCUSSION:CONTINUE]]" }],
      codex: [{ ok: true, text: "최종 결론\n[[CODEPET_DISCUSSION:CONCLUDE]]" }],
    }, calls),
  });
  const result = await room.startDiscussion();
  await settle(room);

  assert.equal(result.ok, true);
  assert.deepEqual(
    calls.map((call) => call.agentId),
    ["claude", "codex"]
  );
  assert.match(calls[0].prompt, /자율 토론 1\/9턴/);
  assert.equal(result.concluded, true);
  const notices = room.messages.filter((message) => message.authorType === "system");
  assert.match(notices[0].text, /토론 시작/);
  assert.match(notices.at(-1).text, /합의하거나 결론/);
});

test("모든 참가자가 새 내용 없이 동의/패스하면 토론을 끝낸다", async () => {
  const calls = [];
  const room = new ChatRoom({
    agents: makeAgents(),
    runAgent: fakeRunner({
      claude: [{ ok: true, text: "동의합니다.\n[[CODEPET_DISCUSSION:AGREE]]" }],
      codex: [{ ok: true, text: "[[CODEPET_DISCUSSION:PASS]]" }],
    }, calls),
  });
  const result = await room.startDiscussion();
  assert.equal(result.concluded, true);
  assert.equal(calls.length, 2);
});

test("결론이 나지 않는 토론은 기본 9턴에서 끝내고 예산 도달을 알린다", async () => {
  const calls = [];
  const room = new ChatRoom({
    agents: makeAgents(),
    runAgent: ({ agent }) => {
      calls.push(agent.id);
      // 상한이 빠지면 즉시 응답하는 토론이 이벤트 루프를 점유해 테스트 타임아웃도
      // 동작하지 않으므로, 넉넉한 호출 수에서 실패로 끊어 멈춤 대신 실패하게 합니다.
      if (calls.length > 20) {
        return { promise: Promise.resolve({ ok: false, error: "토론 상한 없음" }), cancel() {} };
      }
      return { promise: Promise.resolve({ ok: true, text: "검토 중" }), cancel() {} };
    },
  });
  const result = await room.startDiscussion();
  await settle(room);

  assert.equal(result.ok, true);
  assert.equal(result.concluded, false);
  assert.equal(result.truncated, true);
  assert.equal(calls.length, 9);
  const notices = room.messages.filter((message) => message.authorType === "system");
  assert.match(notices[0].text, /최대 9턴/);
  assert.match(notices.at(-1).text, /토론 실행 예산\(9턴\)에 도달/);
});

test("토론 실행 예산을 늘리면 9턴을 넘어 결론이 나올 때까지 이어진다", async () => {
  const calls = [];
  const room = new ChatRoom({
    agents: makeAgents(),
    discussionRunBudget: 20,
    runAgent: ({ agent }) => {
      calls.push(agent.id);
      return { promise: Promise.resolve({ ok: true, text: calls.length === 15
        ? "결론 [[CODEPET_DISCUSSION:CONCLUDE]]"
        : "검토 중 [[CODEPET_DISCUSSION:CONTINUE]]" }), cancel() {} };
    },
  });
  const result = await room.startDiscussion({ rounds: 2 });
  await settle(room);

  assert.equal(result.truncated, false);
  assert.equal(result.concluded, true);
  assert.equal(calls.length, 15);
  const budgetNotice = room.messages.find(
    (message) => message.authorType === "system" && /예산/.test(message.text)
  );
  assert.equal(budgetNotice, undefined);
});

test("토론 중 실제 실행 실패는 반복 재시도하지 않는다", async () => {
  const calls = [];
  const room = new ChatRoom({ agents: makeAgents(),
    runAgent: fakeRunner({ claude: [{ ok: false, error: "CLI 실행 실패" }] }, calls) });
  const result = await room.startDiscussion();
  assert.equal(result.ok, false);
  assert.equal(result.concluded, false);
  assert.equal(calls.length, 1);
  assert.match(room.messages.at(-1).text, /실행이 완료되지 않아/);
});

test("토론에는 사용 가능한 에이전트가 두 명 이상 필요하다", async () => {
  const agents = makeAgents();
  agents[1].enabled = false; // codex 비활성화 → claude만 남음
  const room = new ChatRoom({ agents, runAgent: fakeRunner({}) });
  const result = await room.startDiscussion({ rounds: 1 });
  assert.equal(result.ok, false);
  assert.match(result.error, /두 명 이상/);
});

test("중지하면 토론 나머지 실행이 취소된다", async () => {
  const calls = [];
  const room = new ChatRoom({
    agents: makeAgents(),
    runAgent: ({ agent }) => {
      calls.push(agent.id);
      return {
        promise: new Promise((resolve) => {
          setImmediate(() => {
            if (calls.length === 1) room.stopAll();
            resolve({ ok: true, text: "답" });
          });
        }),
        cancel: () => {},
      };
    },
  });
  await room.startDiscussion({ rounds: 3 });
  await settle(room);

  // 첫 실행 도중 stopAll → 이후 슬롯은 세대 검사로 모두 건너뛴다.
  assert.equal(calls.length, 1);
});

test("토론 종료 표기는 이모티콘 위치 데이터나 화면 본문에 남지 않는다", async () => {
  const room = new ChatRoom({
    agents: makeAgents(),
    runAgent: fakeRunner({
      claude: [{
        ok: true,
        text: "결론입니다.\n[[CODEPET_EMOTE:검토완료]]\n[[CODEPET_DISCUSSION:CONCLUDE]]",
      }],
    }),
  });
  await room.startDiscussion();
  await settle(room);

  const response = room.messages.find((message) => message.author === "claude");
  assert.equal(response.text, "결론입니다.");
  assert.deepEqual(response.contentParts, [
    { type: "text", text: "결론입니다." },
    { type: "emoticon", key: "검토완료", file: "검토완료.png", folder: "claude" },
  ]);
});

test("토론 중 예약된 일반 응답은 토론이 끝날 때까지 발언하지 않는다", async () => {
  const calls = [];
  let releaseFirst;
  const room = new ChatRoom({
    agents: makeAgents(),
    runAgent: ({ agent, prompt }) => {
      calls.push({ agentId: agent.id, discussion: /자율 토론/.test(prompt) });
      if (calls.length === 1) {
        return {
          promise: new Promise((resolve) => { releaseFirst = resolve; }),
          cancel: () => {},
        };
      }
      const text = /자율 토론/.test(prompt)
        ? "토론 결론\n[[CODEPET_DISCUSSION:CONCLUDE]]"
        : "별도 질문 답변";
      return { promise: Promise.resolve({ ok: true, text }), cancel: () => {} };
    },
  });

  const discussion = room.startDiscussion();
  await new Promise((resolve) => setImmediate(resolve));
  room.sendUserMessage("@codex 별도 질문");
  releaseFirst({ ok: true, text: "첫 의견\n[[CODEPET_DISCUSSION:CONTINUE]]" });
  await discussion;
  await settle(room);

  assert.deepEqual(calls, [
    { agentId: "claude", discussion: true },
    { agentId: "codex", discussion: true },
    { agentId: "codex", discussion: false },
  ]);
});

test("중지하면 진행 중인 턴과 같은 참가자의 대기 턴도 폐기한다", async () => {
  const calls = [];
  let resolveActive;
  const room = new ChatRoom({
    agents: makeAgents(),
    random: () => 0.99,
    runAgent: ({ agent }) => {
      calls.push(agent.id);
      return {
        promise: new Promise((resolve) => { resolveActive = resolve; }),
        cancel: () => resolveActive({ ok: false, cancelled: true }),
      };
    },
  });
  room.sendUserMessage("@claude 먼저 답해");
  room.sendUserMessage("@claude 다음 작업");
  await new Promise((resolve) => setImmediate(resolve));
  room.stopAll();
  await settle(room);

  assert.deepEqual(calls, ["claude"]);
  assert.equal(room.turnQueue.length, 0);
});

test("턴 상태는 현재 발언자와 취소 가능한 대기 턴을 공개한다", async () => {
  let releaseActive;
  const states = [];
  const room = new ChatRoom({
    agents: makeAgents(),
    random: () => 0.99,
    runAgent: ({ agent }) => ({
      promise: agent.id === "claude"
        ? new Promise((resolve) => { releaseActive = resolve; })
        : Promise.resolve({ ok: true, text: "두 번째 답" }),
      cancel: () => {},
    }),
  });
  room.on("turn-state", (state) => states.push(state));

  room.sendUserMessage("@claude 먼저 답해");
  room.sendUserMessage("@claude 다음 작업");
  await new Promise((resolve) => setImmediate(resolve));

  const snapshot = room.turnState();
  assert.equal(snapshot.current, "claude");
  assert.equal(snapshot.queue.length, 1);
  assert.equal(snapshot.queue[0].agentId, "claude");
  assert.equal(room.cancelTurn(snapshot.queue[0].turnId), true);
  assert.equal(room.turnState().queue.length, 0);

  releaseActive({ ok: true, text: "첫 번째 답" });
  await settle(room);
  assert.ok(states.some((state) => state.current === "claude"));
  assert.equal(states.at(-1).current, null);
});

test("사용자 개입은 동시 실행을 모두 중지하고 늦은 결과를 버린다", async () => {
  const calls = [];
  let cancelled = false;
  const room = new ChatRoom({
    agents: makeAgents(),
    random: () => 0.99,
    runAgent: ({ agent }) => {
      calls.push(agent.id);
      let resolveActive;
      return {
        promise: new Promise((resolve) => { resolveActive = resolve; }),
        cancel: () => {
          cancelled = true;
          resolveActive({ ok: true, text: "취소 뒤 늦은 답변 @codex" });
        },
      };
    },
  });
  room.sendUserMessage("둘 다 답해");
  await new Promise((resolve) => setImmediate(resolve));

  const result = room.interject();
  await settle(room);

  assert.deepEqual(result, { dropped: 0, interrupted: true });
  assert.equal(cancelled, true);
  assert.deepEqual(calls, ["claude", "codex"]);
  assert.equal(room.messages.filter((message) => message.authorType === "agent").length, 0);
  assert.equal(room.turnState().queue.length, 0);
  assert.match(room.messages.at(-1).text, /다음 차례는 사용자/);
});

test("권한 요청을 승인하면 같은 턴을 자동 승인으로 한 번 다시 실행한다", async () => {
  const calls = [];
  const room = new ChatRoom({
    agents: makeAgents(),
    runAgent: ({ agent, autoApprove }) => {
      calls.push({ agentId: agent.id, autoApprove });
      return {
        promise: Promise.resolve(autoApprove
          ? { ok: true, text: "승인 후 완료" }
          : { ok: false, approvalRequired: true, approval: { summary: "명령 권한" } }),
        cancel: () => {},
      };
    },
  });
  room.once("approval-request", ({ approvalId }) => room.resolveApproval(approvalId, "approve"));
  room.sendUserMessage("@codex 실행해줘");
  await settle(room);
  assert.deepEqual(calls, [
    { agentId: "codex", autoApprove: false },
    { agentId: "codex", autoApprove: true },
  ]);
  assert.equal(room.messages.at(-1).text, "승인 후 완료");
});

test("승인 후 재시도도 권한을 요구하면 상세 원인을 남긴다", async () => {
  const room = new ChatRoom({
    agents: makeAgents(),
    runAgent: () => ({
      promise: Promise.resolve({
        ok: false,
        approvalRequired: true,
        approval: {
          summary: "도구 실행 권한이 필요합니다.",
          detail: "종료 코드 1 · 워크스페이스 밖 경로 접근이 거부되었습니다",
        },
        diagnostics: { provider: "codex", exitCode: 1 },
      }),
      cancel: () => {},
    }),
  });
  room.once("approval-request", ({ approvalId }) => room.resolveApproval(approvalId, "approve"));
  room.sendUserMessage("@codex 실행해줘");
  await settle(room);

  const failure = room.messages.at(-1);
  assert.equal(failure.error, true);
  assert.doesNotMatch(failure.text, /알 수 없는 오류/);
  assert.match(failure.text, /승인 후 재시도에도 권한을 획득하지 못했습니다/);
  assert.match(failure.text, /워크스페이스 밖 경로 접근이 거부되었습니다/);
  assert.equal(failure.diagnostics.approvedRetry, true);
});

test("자동 승인 상태에서 권한 요청이 반환되면 상세 원인을 남긴다", async () => {
  const agents = makeAgents().map((agent) =>
    agent.id === "codex" ? { ...agent, autoApprove: true } : agent
  );
  const calls = [];
  let approvalAsked = false;
  const room = new ChatRoom({
    agents,
    runAgent: ({ autoApprove }) => {
      calls.push(autoApprove);
      return {
        promise: Promise.resolve({
          ok: false,
          approvalRequired: true,
          approval: { summary: "도구 실행 권한이 필요합니다.", detail: "샌드박스 실행 차단" },
        }),
        cancel: () => {},
      };
    },
  });
  room.on("approval-request", () => { approvalAsked = true; });
  room.sendUserMessage("@codex 실행해줘");
  await settle(room);

  assert.deepEqual(calls, [true]);
  assert.equal(approvalAsked, false);
  const failure = room.messages.at(-1);
  assert.equal(failure.error, true);
  assert.doesNotMatch(failure.text, /알 수 없는 오류/);
  assert.match(failure.text, /자동 승인으로 실행했지만 권한 요청이 다시 발생했습니다/);
  assert.match(failure.text, /샌드박스 실행 차단/);
});

test("다른 에이전트의 @멘션으로 시작된 실행은 자동 승인 대신 사용자에게 권한을 묻는다", async () => {
  const agents = makeAgents().map((agent) =>
    agent.id === "codex" ? { ...agent, autoApprove: true } : agent
  );
  const calls = [];
  const prepared = [];
  const approvals = [];
  const room = new ChatRoom({
    agents,
    prepareAgent: ({ agent, autoApprove, agentTriggered }) => {
      prepared.push({ agentId: agent.id, autoApprove, agentTriggered });
    },
    runAgent: ({ agent, autoApprove, agentTriggered }) => {
      calls.push({ agentId: agent.id, autoApprove, agentTriggered });
      if (agent.id === "claude") {
        return { promise: Promise.resolve({ ok: true, text: "@codex 이 명령도 실행해" }), cancel: () => {} };
      }
      return {
        promise: Promise.resolve(autoApprove
          ? { ok: true, text: "실행 완료" }
          : { ok: false, approvalRequired: true, approval: { summary: "명령 권한" } }),
        cancel: () => {},
      };
    },
  });
  room.on("approval-request", ({ agentId, approvalId }) => {
    approvals.push(agentId);
    room.resolveApproval(approvalId, "approve");
  });
  room.sendUserMessage("@claude 확인해줘");
  await settle(room);

  assert.deepEqual(calls, [
    { agentId: "claude", autoApprove: false, agentTriggered: false },
    { agentId: "codex", autoApprove: false, agentTriggered: true },
    { agentId: "codex", autoApprove: true, agentTriggered: true },
  ]);
  assert.deepEqual(prepared.map((item) => item.autoApprove), [false, false, true]);
  assert.deepEqual(approvals, ["codex"]);
  assert.equal(room.messages.at(-1).text, "실행 완료");
});

test("사용자가 직접 부른 실행은 기존처럼 자동 승인을 적용한다", async () => {
  const agents = makeAgents().map((agent) =>
    agent.id === "codex" ? { ...agent, autoApprove: true } : agent
  );
  const calls = [];
  const room = new ChatRoom({
    agents,
    runAgent: ({ autoApprove, agentTriggered }) => {
      calls.push({ autoApprove, agentTriggered });
      return { promise: Promise.resolve({ ok: true, text: "완료" }), cancel: () => {} };
    },
  });
  room.sendUserMessage("@codex 실행해줘");
  await settle(room);

  assert.deepEqual(calls, [{ autoApprove: true, agentTriggered: false }]);
});

test("권한 요청을 거부하면 기존 문구를 유지한다", async () => {
  const calls = [];
  const room = new ChatRoom({
    agents: makeAgents(),
    runAgent: ({ autoApprove }) => {
      calls.push(autoApprove);
      return {
        promise: Promise.resolve({
          ok: false,
          approvalRequired: true,
          approval: { summary: "명령 권한" },
        }),
        cancel: () => {},
      };
    },
  });
  room.once("approval-request", ({ approvalId }) => room.resolveApproval(approvalId, "deny"));
  room.sendUserMessage("@codex 실행해줘");
  await settle(room);

  assert.deepEqual(calls, [false]);
  const failure = room.messages.at(-1);
  assert.equal(failure.error, true);
  assert.equal(failure.text, "권한 요청을 거부했습니다.");
});

test("원인 없는 실패도 내부 식별자로 설명된다", async () => {
  const room = new ChatRoom({
    agents: makeAgents(),
    runAgent: fakeRunner({ codex: [{ ok: false }] }),
  });
  room.sendUserMessage("@codex 실행해줘");
  await settle(room);

  const failure = room.messages.at(-1);
  assert.equal(failure.error, true);
  assert.doesNotMatch(failure.text, /알 수 없는 오류/);
  assert.match(failure.text, /원인이 기록되지 않았습니다/);
});

test("실패한 응답은 오류 메시지로 남는다", async () => {
  const room = new ChatRoom({
    agents: makeAgents(),
    runAgent: fakeRunner({ codex: [{ ok: false, error: "시간 초과 (300초)" }] }),
  });
  room.sendUserMessage("@codex 응답해라");
  await settle(room);

  const agentMessages = room.messages.filter((message) => message.authorType === "agent");
  assert.equal(agentMessages.length, 1);
  assert.equal(agentMessages[0].error, true);
});

test("오류 메시지는 다음 프롬프트의 대화 기록에서 제외된다", async () => {
  const prompts = [];
  const calls = [];
  const room = new ChatRoom({
    agents: makeAgents(),
    runAgent: ({ agent, prompt }) => {
      calls.push(agent.id);
      prompts.push(prompt);
      const result =
        calls.length === 1 ? { ok: false, error: "빈 응답" } : { ok: true, text: "복구!" };
      return { promise: Promise.resolve(result), cancel: () => {} };
    },
  });
  room.sendUserMessage("@codex 하나");
  await settle(room);
  room.sendUserMessage("@codex 둘");
  await settle(room);

  assert.equal(prompts.length, 2);
  assert.doesNotMatch(prompts[1], /빈 응답/);
});

test("중지하면 진행 중인 실행을 취소하고 늦은 결과를 버린다", async () => {
  let cancelled = false;
  let resolveRun;
  const room = new ChatRoom({
    agents: makeAgents(),
    runAgent: () => ({
      promise: new Promise((resolve) => {
        resolveRun = resolve;
      }),
      cancel: () => {
        cancelled = true;
        resolveRun({ ok: false, error: "중지됨", cancelled: true });
      },
    }),
  });
  room.sendUserMessage("@claude 오래 걸리는 일");
  await new Promise((resolve) => setImmediate(resolve));
  room.stopAll();
  await settle(room);

  assert.equal(cancelled, true);
  assert.equal(room.messages.filter((message) => message.authorType === "agent").length, 0);
  assert.equal(room.state().typing.length, 0);
});

test("세대가 바뀐 뒤 도착한 성공 결과도 버려진다 (stale-run 가드)", async () => {
  let resolveRun;
  const room = new ChatRoom({
    agents: makeAgents(),
    runAgent: () => ({
      promise: new Promise((resolve) => {
        resolveRun = resolve;
      }),
      cancel: () => {},
    }),
  });
  room.sendUserMessage("@claude 질문");
  await new Promise((resolve) => setImmediate(resolve));
  room.stopAllSilently();
  resolveRun({ ok: true, text: "늦은 응답" });
  await settle(room);

  assert.equal(room.messages.filter((message) => message.authorType === "agent").length, 0);
});

test("run-event가 시작/진행/종료 순으로 전달된다", async () => {
  const events = [];
  const room = new ChatRoom({
    agents: makeAgents(),
    runAgent: ({ emitEvent }) => ({
      promise: new Promise((resolve) => {
        setImmediate(() => {
          emitEvent({ kind: "status", label: "생각 중" });
          emitEvent({ kind: "delta", text: "부분" });
          resolve({ ok: true, text: "최종" });
        });
      }),
      cancel: () => {},
    }),
  });
  room.on("run-event", (event) => events.push(event));
  room.sendUserMessage("@claude 진행 보여줘");
  await settle(room);

  const kinds = events.map((event) => event.kind);
  assert.deepEqual(kinds, ["run-start", "status", "delta", "run-end"]);
  assert.equal(events[0].agentId, "claude");
  assert.ok(events[0].runId);
});

test("첨부가 있는 사용자 메시지는 첨부 메타와 함께 저장되고 러너로 전달된다", async () => {
  const received = [];
  const room = new ChatRoom({
    agents: makeAgents(),
    runAgent: ({ attachments, prompt }) => {
      received.push({ attachments, prompt });
      return { promise: Promise.resolve({ ok: true, text: "봤어요" }), cancel: () => {} };
    },
  });
  const attachment = { id: "abc", name: "shot.png", mime: "image/png", size: 10, kind: "image" };
  room.sendUserMessage({ text: "@claude 이것 봐", attachments: [attachment] });
  await settle(room);

  const userMessage = room.messages.find((message) => message.authorType === "user");
  assert.deepEqual(userMessage.attachments, [attachment]);
  assert.deepEqual(received[0].attachments, [attachment]);
  assert.match(received[0].prompt, /\[첨부: shot\.png\]/);
});

test("텍스트 없이 첨부만으로도 메시지를 보낼 수 있다", () => {
  const room = new ChatRoom({ agents: makeAgents(), runAgent: fakeRunner({}) });
  const entry = room.sendUserMessage({
    text: "",
    attachments: [{ id: "a", name: "f.txt", mime: "text/plain", size: 1, kind: "text" }],
  });
  assert.ok(entry);
  assert.equal(room.messages.length, 1);
});

test("대화 지우기는 메시지를 비우고 reset 이벤트를 낸다", async () => {
  const room = new ChatRoom({ agents: makeAgents(), runAgent: fakeRunner({}) });
  let resetCount = 0;
  room.on("reset", () => {
    resetCount += 1;
  });
  room.sendUserMessage("안녕");
  room.clear();

  assert.equal(room.messages.length, 0);
  assert.equal(resetCount, 1);
});

test("publicAgents에는 실행 경로 정보가 없다", () => {
  const agents = makeAgents();
  agents[0].commandPath = "C:\\secret\\claude.exe";
  agents[0].needsShell = true;
  const room = new ChatRoom({ agents, runAgent: fakeRunner({}) });
  const json = JSON.stringify(room.state());
  assert.ok(!json.includes("commandPath"));
  assert.ok(!json.includes("needsShell"));
  assert.ok(!json.includes("secret"));
});

test("사용자 인용 정보는 허용 필드만 정제해 메시지에 저장한다", () => {
  const room = new ChatRoom({ agents: [], runAgent: fakeRunner({}) });
  const entry = room.sendUserMessage({
    text: "이 부분을 검토해줘",
    replyTo: {
      messageId: "  m-original  ",
      author: "  codex  ",
      authorType: "agent",
      excerpt: ` 첫 줄\n${"가".repeat(240)} `,
      untrusted: "저장되면 안 됨",
    },
  });

  assert.deepEqual(Object.keys(entry.replyTo), ["messageId", "author", "authorType", "excerpt"]);
  assert.equal(entry.replyTo.messageId, "m-original");
  assert.equal(entry.replyTo.author, "codex");
  assert.equal(entry.replyTo.authorType, "agent");
  assert.equal(entry.replyTo.excerpt.length, 200);
  assert.ok(!entry.replyTo.excerpt.includes("\n"));
  assert.equal(Object.hasOwn(entry.replyTo, "untrusted"), false);
});

test("비객체이거나 필수 필드가 잘못된 인용 정보는 저장하지 않는다", () => {
  const values = [
    "m-original",
    ["m-original"],
    { messageId: "m1", author: "codex", authorType: "system", excerpt: "내용" },
    { messageId: "m1", author: "codex", authorType: "agent", excerpt: "   " },
  ];

  for (const replyTo of values) {
    const room = new ChatRoom({ agents: [], runAgent: fakeRunner({}) });
    const entry = room.sendUserMessage({ text: "답장", replyTo });
    assert.equal(Object.hasOwn(entry, "replyTo"), false);
  }
});
