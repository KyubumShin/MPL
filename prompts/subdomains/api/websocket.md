# Subdomain: API/WebSocket (WebSocket 실시간 통신)

## 핵심 원칙
- Connection lifecycle(open → message → error → close)의 모든 상태를 명시적으로 처리
- Heartbeat(ping/pong)으로 유령 연결(ghost connection) 감지 및 정리
- 클라이언트 재연결은 지수 백오프(exponential backoff) + 지터(jitter) 전략 적용
- 메시지는 타입 필드를 포함한 명시적 구조로 직렬화 (예: `{ type, payload, id }`)

## 주의 사항
- 브로드캐스트 시 연결 수에 비례한 메모리/CPU 비용 고려 — room/channel 단위 격리
- 대용량 메시지는 분할(chunking) 또는 압축(permessage-deflate) 적용
- Backpressure 처리 누락 시 버퍼 초과로 연결 드랍 발생
- 인증 토큰은 연결 시 handshake에서 검증 — 메시지마다 재검증 불필요하나 만료 처리 필수

## 검증 포인트
- 서버 재시작 후 클라이언트가 자동으로 재연결하는가?
- ping 응답이 없는 연결이 설정된 타임아웃 내에 종료되는가?
- 동일 room의 메시지가 해당 구독자에게만 전달되는가?
- 연결 해제 시 서버 측 리소스(이벤트 리스너, DB 커서 등)가 정리되는가?
