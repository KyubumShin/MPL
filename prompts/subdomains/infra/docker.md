# Subdomain: Infra/Docker (Docker 컨테이너 빌드 및 실행)

## 핵심 원칙
- Multi-stage build로 빌드 의존성을 최종 이미지에서 분리해 이미지 크기 최소화
- 자주 변경되는 레이어(소스 코드)는 Dockerfile 후반부에 배치해 캐시 재사용 극대화
- `.dockerignore`로 `node_modules`, `.git`, 로컬 환경 파일 등을 빌드 컨텍스트에서 제외
- 컨테이너는 root가 아닌 전용 비권한 사용자(USER)로 실행

## 주의 사항
- `latest` 태그 사용 금지 — 베이스 이미지는 정확한 버전과 digest로 고정
- 민감 정보(API 키, 시크릿)를 `ENV` 또는 이미지 레이어에 포함 금지 — 런타임 시크릿 마운트 사용
- `HEALTHCHECK` 없이 오케스트레이터가 컨테이너 상태를 정확히 파악 불가
- Compose 네트워킹에서 서비스 간 통신은 서비스 이름(DNS)으로 참조 — IP 하드코딩 금지

## 검증 포인트
- 최종 이미지 크기가 Multi-stage 빌드로 충분히 줄었는가? (`docker image ls` 확인)
- `docker scan` 또는 Trivy로 알려진 CVE가 없는가?
- `HEALTHCHECK`가 애플리케이션 실제 준비 상태를 반영하는가?
- Volume 마운트가 컨테이너 재시작 후에도 데이터를 보존하는가?
