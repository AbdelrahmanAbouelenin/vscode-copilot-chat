from abc import ABC, abstractmethod

class Base(ABC):
    @abstractmethod
    def foo(self, x: int) -> int:
        pass

def foo2():
    Base()