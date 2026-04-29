import os


class Service:
    def handle_request(self, path: str) -> str:
        return path


def create_service() -> Service:
    return Service()
