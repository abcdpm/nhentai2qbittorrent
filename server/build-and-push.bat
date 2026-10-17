@echo off
rem ==========================================================
rem Build Docker image and push to Docker Hub (Windows batch)
rem
rem Each run uploads two tags:
rem   <version> (IMAGE_TAG from .env) and latest
rem
rem Usage:
rem   build-and-push.bat                use .env / defaults
rem   build-and-push.bat 1.1.0          set version (written back to .env)
rem   build-and-push.bat 1.1.0 myuser   set [version] [DockerHub user]
rem
rem Value priority (first non-empty wins):
rem   command args - env vars (DOCKERHUB_USER/IMAGE_TAG) - .env - defaults
rem   default user: llllalex    default tag: 1.0.0
rem
rem docker-compose.yml does not build images, it only pulls and runs:
rem   docker compose pull / up -d
rem
rem NOTE: this file is ASCII-only on purpose. cmd.exe parses batch
rem files with the system ANSI codepage, so non-ASCII (e.g. UTF-8
rem Chinese) bytes break line parsing. Messages are in English here;
rem see README.md (Chinese) for details.
rem
rem The script pauses at the end so double-click output stays visible.
rem ==========================================================
setlocal EnableExtensions
cd /d "%~dp0"

set "DEFAULT_USER=llllalex"
set "DEFAULT_TAG=1.0.0"
set "RC=0"

rem ---- resolve values: command args - env vars - .env - defaults ----
set "FILE_USER="
set "FILE_TAG="
if exist ".env" (
    for /f "usebackq tokens=1,* delims==" %%A in (".env") do (
        if /i "%%~A"=="DOCKERHUB_USER" set "FILE_USER=%%~B"
        if /i "%%~A"=="IMAGE_TAG" set "FILE_TAG=%%~B"
    )
)

set "USER_NAME=%~2"
if not defined USER_NAME if defined DOCKERHUB_USER set "USER_NAME=%DOCKERHUB_USER%"
if not defined USER_NAME if defined FILE_USER set "USER_NAME=%FILE_USER%"
if not defined USER_NAME set "USER_NAME=%DEFAULT_USER%"

set "TAG=%~1"
if not defined TAG if defined IMAGE_TAG set "TAG=%IMAGE_TAG%"
if not defined TAG if defined FILE_TAG set "TAG=%FILE_TAG%"
if not defined TAG set "TAG=%DEFAULT_TAG%"

rem ---- check docker ----
where docker >nul 2>nul
if not errorlevel 1 goto :docker_ok
echo ERROR: docker not found, please install Docker first
set "RC=1"
goto :end
:docker_ok

set "IMAGE=%USER_NAME%/nh-download-server"
set "PLATFORM_ARGS="
if defined BUILD_PLATFORM set "PLATFORM_ARGS=--platform %BUILD_PLATFORM%"

echo ==^> Building images: %IMAGE%:%TAG% and %IMAGE%:latest
call docker build %PLATFORM_ARGS% --build-arg APP_VERSION="%TAG%" -t "%IMAGE%:%TAG%" -t "%IMAGE%:latest" .
if not errorlevel 1 goto :build_ok
set "RC=1"
goto :end
:build_ok

rem ---- log in to Docker Hub first if not logged in yet ----
rem ---- (no docker.io entry in config.json counts as logged out) ----
set "DOCKER_CONFIG=%USERPROFILE%\.docker\config.json"
if not defined USERPROFILE set "DOCKER_CONFIG=%HOME%\.docker\config.json"
findstr /c:"index.docker.io" "%DOCKER_CONFIG%" >nul 2>nul
if not errorlevel 1 goto :logged_in
echo ==^> Not logged in to Docker Hub yet, please log in
call docker login
if not errorlevel 1 goto :logged_in
set "RC=1"
goto :end
:logged_in

echo ==^> Pushing %IMAGE%:%TAG%
call docker push "%IMAGE%:%TAG%"
if not errorlevel 1 goto :push1_ok
set "RC=1"
goto :end
:push1_ok

if /i "%TAG%"=="latest" goto :pushed
echo ==^> Pushing %IMAGE%:latest
call docker push "%IMAGE%:latest"
if not errorlevel 1 goto :pushed
set "RC=1"
goto :end
:pushed

rem ---- write user and tag back to .env for docker-compose.yml ----
(
    echo DOCKERHUB_USER=%USER_NAME%
    echo IMAGE_TAG=%TAG%
) > ".env"
echo ==^> Written to .env: DOCKERHUB_USER=%USER_NAME%, IMAGE_TAG=%TAG%

echo.
echo Done! Pushed both tags: %IMAGE%:%TAG% and %IMAGE%:latest
echo   Deploy:  docker compose pull ^&^& docker compose up -d
echo   API key: docker logs nh-download-server   (or ./data/INITIAL_API_KEY.txt)

:end
echo.
pause
exit /b %RC%