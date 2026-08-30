ARG MCC_VERSION=20260829-511

FROM mcr.microsoft.com/dotnet/sdk:10.0-noble AS build
ARG MCC_VERSION
WORKDIR /src
RUN git clone --depth 1 --branch ${MCC_VERSION} --recurse-submodules --shallow-submodules \
		https://github.com/MCCTeam/Minecraft-Console-Client.git . && \
	dotnet publish the client source.csproj \
		-c Release -o /out --self-contained true -p:PublishSingleFile=false

FROM mcr.microsoft.com/dotnet/runtime-deps:10.0-noble-chiseled AS runtime
COPY --from=build --chown=10001:10001 /out /app
COPY --from=build --chown=10001:10001 /src/LICENSE.md /app/LICENSE.md
WORKDIR /app
USER 10001:10001
ENTRYPOINT ["/app/MinecraftClient", "BasicIO-NoColor"]
