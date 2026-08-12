# syntax=docker/dockerfile:1

# ---- Build ----
FROM mcr.microsoft.com/dotnet/sdk:10.0 AS build
WORKDIR /src

# Restore first (cached unless the csproj changes).
COPY server/BlockBlitz.Server.csproj server/
RUN dotnet restore server/BlockBlitz.Server.csproj

# Publish. UseAppHost=false: we launch via `dotnet BlockBlitz.Server.dll`, no native host needed.
COPY server/ server/
RUN dotnet publish server/BlockBlitz.Server.csproj -c Release -o /publish /p:UseAppHost=false

# ---- Runtime ----
FROM mcr.microsoft.com/dotnet/aspnet:10.0 AS runtime
WORKDIR /app
COPY --from=build /publish ./
# The static Babylon.js client, served by the server from CLIENT_PATH.
COPY client/ /client/

ENV CLIENT_PATH=/client \
    ASPNETCORE_URLS=http://0.0.0.0:8080 \
    MaxPlayers=16

EXPOSE 8080
ENTRYPOINT ["dotnet", "BlockBlitz.Server.dll"]
