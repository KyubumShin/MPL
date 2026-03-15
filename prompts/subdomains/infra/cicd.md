# Subdomain: Infra/CICD (CI/CD 파이프라인 설계)

## 핵심 원칙
- GitHub Actions workflow는 트리거(`on`), 권한(`permissions`), 잡(`jobs`) 구조를 명시적으로 선언
- Matrix 전략으로 다중 OS/런타임 버전 조합을 단일 workflow에서 병렬 테스트
- 의존성 캐싱(`actions/cache`)으로 npm/pip/cargo 설치 시간을 반복 실행에서 단축
- Environment protection rules로 프로덕션 배포 전 수동 승인(manual approval) 강제

## 주의 사항
- 시크릿은 반드시 GitHub Secrets/OIDC로 관리 — workflow 파일이나 로그에 출력 금지
- `actions/checkout`에서 `persist-credentials: false` 설정 — 불필요한 자격증명 노출 방지
- 잡 간 아티팩트 공유는 `upload-artifact`/`download-artifact` 사용 — 직접 파일 경로 참조 금지
- Self-hosted runner 사용 시 PR에서 악성 코드 실행 위험 — fork PR에 대한 권한 제한 필수

## 검증 포인트
- Workflow가 main 브랜치 push와 PR 모두에서 올바르게 트리거되는가?
- 실패한 잡이 배포 단계를 차단하는 `needs` 의존성이 설정되어 있는가?
- 캐시 키가 의존성 파일(package-lock.json, requirements.txt)의 해시를 포함하는가?
- 배포 workflow의 실행 권한이 최소 필요 scope로 제한되어 있는가?
