FROM debian:stable

RUN apt update &&\
    apt install -y composer php8.2-sqlite3 php8.2-dom curl &&\
    curl https://get.wasmer.io -sSfL | sh
ENV PATH=/root/.wasmer/bin:$PATH
RUN apt install build-essential gcc make -y
RUN curl https://sh.rustup.rs -sSf | sh -s -- -y
ENV PATH=/root/.cargo/bin:$PATH
