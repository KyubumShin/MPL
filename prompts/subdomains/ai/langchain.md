# Subdomain: AI/LangChain (LangChain 체인 및 에이전트)

## 핵심 원칙
- LCEL(LangChain Expression Language) 파이프(`|`)로 체인 구성 — 레거시 `LLMChain` 직접 사용 지양
- Agent 패턴은 tool 목록과 stopping 조건을 명시적으로 제한 — 무한 루프 방지
- Callback/tracer(`LangSmith`)를 개발 단계부터 연결해 체인 실행 가시성 확보
- Retriever는 벡터 스토어와 메타데이터 필터를 조합해 검색 정확도 향상

## 주의 사항
- Memory 타입(BufferMemory vs SummaryMemory)은 컨텍스트 길이와 비용 트레이드오프 고려
- 각 LLM 호출에 `max_tokens`와 타임아웃 명시 — 비용 폭발과 레이턴시 스파이크 방지
- `StructuredOutputParser`/`JsonOutputParser` 사용 시 LLM 출력 파싱 실패 처리 필수
- Tool binding 시 도구 설명(description)이 LLM의 도구 선택 품질에 직결 — 명확하게 작성

## 검증 포인트
- LangSmith 트레이스에서 각 체인 단계의 입출력과 레이턴시가 확인되는가?
- 에이전트가 최대 반복 횟수(`max_iterations`) 내에 종료하는가?
- Retriever가 관련 청크를 상위에 랭크하는가? (MMR 또는 score threshold 설정 확인)
- 파싱 오류 발생 시 재시도 또는 fallback chain이 동작하는가?
