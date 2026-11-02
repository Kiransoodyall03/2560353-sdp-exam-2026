# The ARL Simulator

## Docker

### Running everything

```
tar -xzf arl-sim.tar.gz
cd arl-sim
for t in images/*.tar; do docker load -i "$t"; done
docker compose -f arl-test.yaml up -d
```

The MQTT broker is on `localhost:1883` and the ARL API on `http://localhost:8080` (documentation at `/docs`).

### Running a specific service

The following services are available:

* rta
* mhe
* lwm
* opg
* owt

```
docker compose -f arl-test.yaml up -d <service-name>
```

The broker, the API and its database start automatically.

## Binary

Linux x86_64 only (on Windows, use WSL). Start the broker and the API with Docker, then run the service:

```
docker compose -f arl-test.yaml up -d api
MQTT_BROKER_ADDRESS=localhost ARL_API_ADDRESS=localhost ./bin/arl-<service-name> --config config/<service-name>.toml
```

The RTA and LWM read files from the Docker image. Copy them out once and point a copy of the configuration at them:

```
docker create --name arl-files arl/rta:0.1.0
docker cp arl-files:/assets ./assets
docker rm arl-files
sed 's#"/assets#"assets#' config/rta.toml > rta.local.toml
MQTT_BROKER_ADDRESS=localhost ARL_API_ADDRESS=localhost ./bin/arl-rta --config rta.local.toml
```

To run several binaries at once, give each its own `HEALTH_PORT`, for example `HEALTH_PORT=9101`.
